//! Fragmented MP4 encoder built on ffmpeg-next.
//!
//! Replaces the previous `AvWriter` (cidre/AVAssetWriter) pipeline. SCK
//! still delivers `cm::SampleBuf`s; conversion into `ffmpeg::frame::*`
//! happens at the boundary in `recording.rs`. This module owns the
//! libavcodec encoders + libavformat muxer and writes a streamable
//! fragmented MP4 the existing tail-and-upload pipeline can ship.
//!
//! Why ffmpeg, not AVAssetWriter:
//!   - AVAssetWriter rejected our system-audio sample buffers with
//!     OSStatus -16341 in subtle ways every iteration of the rebuild
//!     hit a different sharp edge (timescale mixing, planar layout,
//!     channel layout descriptors).
//!   - libavcodec's `h264_videotoolbox` is the same VideoToolbox encoder
//!     AVAssetWriter wraps internally, but we drive it ourselves with
//!     explicit PTS so AVAssetWriter's session/timebase rules don't
//!     apply.
//!   - libavcodec's `aac` encoder accepts planar f32 PCM once live
//!     capture chunks are batched into its required frame size.
//!
//! Streamability comes from the muxer flags:
//!   `movflags = +frag_keyframe+empty_moov+default_base_moof`
//!   `frag_duration = 1_000_000` (1 second in microseconds)
//!
//! That writes [ftyp][empty moov][moof+mdat]... with one fragment per
//! second — exactly the shape the streaming uploader has been tailing.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::path::Path;

use anyhow::{anyhow, bail, Result};
#[cfg(target_os = "macos")]
use cidre::{cat, cm, cv};
use ffmpeg::{
    codec::{self, codec::Codec, encoder},
    format::{self, Pixel, Sample},
    frame, software, ChannelLayout, Dictionary, Rational,
};

/// Video-track time base (microseconds). All `frame::Video` PTS values
/// are integers in this base.
pub const VIDEO_TIME_BASE: i32 = 1_000_000;

/// Audio sample rate (Hz). Encoder + muxer work in `(1, SAMPLE_RATE)`
/// time base so audio PTS == cumulative-samples-since-start.
pub const SAMPLE_RATE: i32 = 48_000;
pub const AUDIO_CHANNELS: u16 = 2;
const FRAGMENTED_MP4_TRAILER_ERRNOS: &[i32] = &[110, 300];
/// How far the silent audio prefill trails the newest video frame. Real audio
/// that reaches the encoder later than this behind video would lose its
/// overlapping start, so it is kept well above the pumps' audio latency
/// (tens of milliseconds) while still keeping the audio track interleaved.
const SILENCE_PREFILL_LAG_US: i64 = 2_000_000;
/// Largest run of silence the prefill appends before encoding it: one second.
const SILENCE_PAD_CHUNK_SAMPLES: i64 = SAMPLE_RATE as i64;

#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_bitrate_bps: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_bps: 3_500_000,
        }
    }
}

pub struct Mp4Encoder {
    output: format::context::Output,
    video: VideoLane,
    audio: AudioLane,
    finished: bool,
    /// See `enable_silence_prefill`. Off by default.
    silence_prefill: bool,
    /// Newest video PTS queued, in `VIDEO_TIME_BASE`.
    last_video_pts_us: Option<i64>,
    /// One video frame at the configured rate, in `VIDEO_TIME_BASE`.
    frame_interval_us: i64,
}

// SAFETY: ffmpeg's context types wrap raw pointers, so the compiler
// won't auto-derive `Send`. The encoders, format context, and packets
// are designed to be moved between threads (just not concurrently
// accessed) — same pattern Cap.so's `MP4Encoder` and Rust ffmpeg-next
// projects rely on. We only ever own one `Mp4Encoder` per recording
// and call its methods from a single tokio task.
unsafe impl Send for Mp4Encoder {}

struct VideoLane {
    encoder: encoder::Video,
    stream_index: usize,
    /// Encoder time base = `(1, VIDEO_TIME_BASE)`.
    time_base: Rational,
    /// Pixel-format converter. SCK gives us BGRA; the videotoolbox
    /// encoder accepts NV12 cleanly on Apple Silicon.
    converter: Option<software::scaling::Context>,
    /// Only for frames whose size differs from the configured one: scales
    /// them to fit and letterboxes them (see `queue`). Built on first need.
    resizer: Option<FrameResizer>,
    /// Frames that went through `resizer`.
    rescaled_frames: u64,
    packet: ffmpeg::Packet,
    width: u32,
    height: u32,
}

/// Scales a frame of one size into the encoder's size, keeping its aspect
/// ratio, with black bars filling the rest (as Cap does for a display whose
/// size changed mid-take).
struct FrameResizer {
    source: (Pixel, u32, u32),
    fit: FitRect,
    scaler: software::scaling::Context,
}

/// Where a scaled frame sits inside the encoder's frame. Every value is
/// even, so the NV12 chroma plane lines up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FitRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// The largest rectangle with the source's aspect ratio that fits in the
/// destination, centred.
fn fit_rect(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> FitRect {
    let even = |v: u64| ((v.min(u64::from(u32::MAX)) as u32) & !1).max(2);
    let (src_w, src_h) = (u64::from(src_w.max(1)), u64::from(src_h.max(1)));
    let (dw, dh) = (u64::from(dst_w), u64::from(dst_h));
    let (width, height) = if src_w * dh >= src_h * dw {
        (dw, (src_h * dw + src_w / 2) / src_w)
    } else {
        ((src_w * dh + src_h / 2) / src_h, dh)
    };
    let width = even(width).min((dst_w & !1).max(2));
    let height = even(height).min((dst_h & !1).max(2));
    FitRect {
        x: (dst_w.saturating_sub(width) / 2) & !1,
        y: (dst_h.saturating_sub(height) / 2) & !1,
        width,
        height,
    }
}

/// Copy an NV12 frame into a black NV12 frame of `dst_w` x `dst_h` at `fit`.
fn letterbox_nv12(src: &frame::Video, dst_w: u32, dst_h: u32, fit: FitRect) -> frame::Video {
    let mut out = frame::Video::new(Pixel::NV12, dst_w, dst_h);
    // Video-range black: Y 16, Cb/Cr 128.
    out.data_mut(0).fill(16);
    out.data_mut(1).fill(128);
    let (x, y, w, h) = (
        fit.x as usize,
        fit.y as usize,
        fit.width as usize,
        fit.height as usize,
    );
    for plane in 0..2 {
        let rows = if plane == 0 { h } else { h / 2 };
        let top = if plane == 0 { y } else { y / 2 };
        let src_stride = src.stride(plane);
        let dst_stride = out.stride(plane);
        let src_data = src.data(plane);
        let dst_data = out.data_mut(plane);
        for row in 0..rows {
            let s = row * src_stride;
            let d = (top + row) * dst_stride + x;
            dst_data[d..d + w].copy_from_slice(&src_data[s..s + w]);
        }
    }
    out
}

struct AudioLane {
    encoder: encoder::Audio,
    stream_index: usize,
    /// Encoder time base = `(1, SAMPLE_RATE)`.
    time_base: Rational,
    packet: ffmpeg::Packet,
    buffer: AudioFrameBuffer,
}

impl Mp4Encoder {
    /// One-time global init; ffmpeg-next is safe to call this repeatedly.
    pub fn init_global() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let _ = ffmpeg::init();
        });
    }

    pub fn open(path: &Path, cfg: Config) -> Result<Self> {
        Self::init_global();

        let path_str = path
            .to_str()
            .ok_or_else(|| anyhow!("encoder output path is not valid UTF-8"))?;

        // `format::output_as` lets us force the muxer to "mp4" regardless
        // of the file extension (we end up writing MP4 bytes under a
        // `.mp4` name; the streaming server treats it as opaque bytes).
        let mut output =
            format::output_as(path_str, "mp4").map_err(|e| anyhow!("format::output_as: {e:?}"))?;

        // mp4 muxer demands SPS/PPS in `extradata` (avcC box), not inline
        // in packets. Encoders must opt into this via the GLOBAL_HEADER
        // flag, gated on the muxer reporting that it expects it.
        let global_header = output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER);

        let video = VideoLane::open(&mut output, &cfg, global_header)?;
        let audio = AudioLane::open(&mut output, global_header)?;

        // Fragmented-MP4 muxer flags. These must be set on `write_header`
        // via the options dict — the muxer reads them once and bakes
        // the file shape decision in for the rest of the run.
        // Stock streaming-MP4 combo: empty moov at the start, fragments
        // emitted at every keyframe. We skip the optional mfra/tfra/mfro
        // trailer because the file is tailed while recording and those
        // footer indexes are not needed for playback from moof/mdat
        // fragments. On macOS/ffmpeg 7 the trailer write can otherwise
        // return a bogus OS error after all media packets are already
        // flushed.
        let mut opts = Dictionary::new();
        opts.set(
            "movflags",
            "+frag_keyframe+empty_moov+default_base_moof+skip_trailer",
        );
        // The streaming uploader tails this file — fragment cadence IS the
        // upload latency. frag_keyframe alone cuts only at GOP boundaries
        // (2 s), and movenc buffers the open fragment in memory, so bytes
        // reached disk in 2 s bursts. frag_duration cuts at ~1 s even
        // mid-GOP, and flush_packets pushes each finished fragment through
        // the avio buffer immediately instead of at the next 32 KiB fill.
        opts.set("frag_duration", "1000000");
        opts.set("flush_packets", "1");

        output
            .write_header_with(opts)
            .map_err(|e| anyhow!("write_header_with: {e:?}"))?;

        tracing::debug!(
            path = %path_str,
            width = cfg.width,
            height = cfg.height,
            fps = cfg.fps,
            video_bitrate_bps = cfg.video_bitrate_bps,
            sample_rate = SAMPLE_RATE,
            audio_channels = AUDIO_CHANNELS,
            "MP4 encoder initialised (fragmented)"
        );

        Ok(Self {
            output,
            video,
            audio,
            finished: false,
            silence_prefill: false,
            last_video_pts_us: None,
            frame_interval_us: VIDEO_TIME_BASE as i64 / i64::from(cfg.fps.max(1)),
        })
    }

    /// Never leave the audio track without packets.
    ///
    /// The AAC track is always declared, but silence used to be written only
    /// into gaps BETWEEN real audio frames. A take where no audio frame ever
    /// arrived (mic off or failed, and WASAPI loopback idle because nothing
    /// played) ended with a zero-packet track, and one where audio stopped
    /// (loopback with nothing playing) ended its track early. With this on,
    /// whenever audio falls more than `SILENCE_PREFILL_LAG_US` behind the
    /// newest video frame the gap is filled with silence, and `finish` fills
    /// the track to the end of the video. Real audio that arrives inside the
    /// lag window lands exactly as before.
    pub fn enable_silence_prefill(&mut self) {
        self.silence_prefill = true;
    }

    fn prefill_audio_silence_to_us(&mut self, target_us: i64) {
        if !self.silence_prefill || target_us <= 0 {
            return;
        }
        let target_samples =
            target_us.saturating_mul(SAMPLE_RATE as i64) / VIDEO_TIME_BASE as i64;
        if let Err(err) = self.audio.pad_silence_to(&mut self.output, target_samples) {
            // Never let the prefill cost a video frame: give up on it and
            // leave the audio track to real audio, as before.
            tracing::warn!("silent audio prefill failed; turning it off: {err:#}");
            self.silence_prefill = false;
        }
    }

    /// Compute a video PTS in the encoder's time base from a duration
    /// since recording start. Callers anchor `since_start` to whatever
    /// origin they like (typically the first SCK video frame).
    pub fn video_pts(since_start: std::time::Duration) -> i64 {
        (since_start.as_secs_f64() * VIDEO_TIME_BASE as f64) as i64
    }

    /// Compute an audio PTS in the encoder's time base (sample-rate).
    pub fn audio_pts(since_start: std::time::Duration) -> i64 {
        (since_start.as_secs_f64() * SAMPLE_RATE as f64) as i64
    }

    /// Frames whose size differed from the encoder's and were scaled to fit.
    pub fn rescaled_video_frames(&self) -> u64 {
        self.video.rescaled_frames
    }

    pub fn queue_video(&mut self, frame: frame::Video) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        let pts = frame.pts();
        self.video.queue(&mut self.output, frame)?;
        if let Some(pts) = pts {
            self.last_video_pts_us = Some(self.last_video_pts_us.map_or(pts, |last| last.max(pts)));
            self.prefill_audio_silence_to_us(pts.saturating_sub(SILENCE_PREFILL_LAG_US));
        }
        Ok(())
    }

    pub fn queue_audio(&mut self, frame: frame::Audio) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        self.audio.queue(&mut self.output, frame)
    }

    /// Flush both encoders, write the trailer, close the file. Idempotent.
    pub fn finish(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;

        if let Some(last_video_pts_us) = self.last_video_pts_us {
            // Fill the track to the end of the video so it is as long as the
            // take, whether audio never arrived or stopped early.
            self.prefill_audio_silence_to_us(
                last_video_pts_us.saturating_add(self.frame_interval_us),
            );
        }
        self.video.flush(&mut self.output)?;
        self.audio.flush(&mut self.output)?;
        if let Err(err) = self.output.write_trailer() {
            if is_fragmented_mp4_trailer_error(err) {
                tracing::warn!(
                    "fragmented MP4 trailer write failed after media data was flushed; \
                     treating as non-fatal: {err:?}"
                );
            } else {
                return Err(anyhow!("write_trailer: {err:?}"));
            }
        }
        Ok(())
    }
}

fn is_fragmented_mp4_trailer_error(err: ffmpeg::Error) -> bool {
    matches!(
        err,
        ffmpeg::Error::Other { errno }
            if FRAGMENTED_MP4_TRAILER_ERRNOS.contains(&errno)
                || FRAGMENTED_MP4_TRAILER_ERRNOS.contains(&-errno)
    )
}

impl Drop for Mp4Encoder {
    fn drop(&mut self) {
        if !self.finished {
            if let Err(err) = self.finish() {
                tracing::warn!(
                    "Mp4Encoder dropped without explicit finish; trailer write failed: {err:#}"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Video lane
// ---------------------------------------------------------------------------

impl VideoLane {
    fn open(
        output: &mut format::context::Output,
        cfg: &Config,
        global_header: bool,
    ) -> Result<Self> {
        // Prefer hardware: VideoToolbox H.264. Falls back to libx264 if VT
        // isn't available (shouldn't happen on macOS but worth being safe).
        let (codec, encoder_options) = pick_video_codec(cfg);

        // VideoToolbox wants NV12 input on macOS. SCK delivers BGRA, so
        // we always plumb a converter on this path. (The converter is
        // cheap and runs in CPU since SCK frames are CPU-side already.)
        let encoder_format = Pixel::NV12;
        let mut encoder_ctx = codec::context::Context::new_with_codec(codec);
        encoder_ctx.set_threading(codec::threading::Config::count(2));

        let mut video_encoder = encoder_ctx.encoder().video()?;
        if global_header {
            video_encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        video_encoder.set_width(cfg.width);
        video_encoder.set_height(cfg.height);
        video_encoder.set_format(encoder_format);
        video_encoder.set_time_base(Rational::new(1, VIDEO_TIME_BASE));
        video_encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
        video_encoder.set_bit_rate(cfg.video_bitrate_bps);
        video_encoder.set_max_bit_rate(constrained_vbr_max_bitrate(cfg.video_bitrate_bps));
        video_encoder.set_gop(cfg.fps * 2);

        let video_encoder = video_encoder
            .open_with(encoder_options)
            .map_err(|e| anyhow!("video encoder open: {e:?}"))?;

        let mut stream = output.add_stream(codec)?;
        let stream_index = stream.index();
        stream.set_time_base(Rational::new(1, VIDEO_TIME_BASE));
        stream.set_parameters(&video_encoder);

        let converter = software::converter((cfg.width, cfg.height), Pixel::BGRA, encoder_format)
            .map_err(|e| anyhow!("BGRA → NV12 converter init: {e:?}"))?;

        Ok(Self {
            encoder: video_encoder,
            stream_index,
            time_base: Rational::new(1, VIDEO_TIME_BASE),
            converter: Some(converter),
            resizer: None,
            rescaled_frames: 0,
            packet: ffmpeg::Packet::empty(),
            width: cfg.width,
            height: cfg.height,
        })
    }

    fn queue(&mut self, output: &mut format::context::Output, frame: frame::Video) -> Result<()> {
        let size_matches = frame.width() == self.width && frame.height() == self.height;
        let frame_to_send = if !size_matches && self.converter.is_some() {
            // The converter and the encoder are fixed at the configured
            // size, so a frame of another size used to fail here, and every
            // frame after it too. Scale it to fit instead.
            self.resize(frame)?
        } else if let Some(conv) = self.converter.as_mut() {
            // Only convert if the inbound frame isn't already in the
            // encoder's format. The recording.rs side will normally feed
            // BGRA; smoke tests construct frames in the encoder format
            // directly to skip this step.
            if frame.format() != self.encoder.format() {
                let mut converted = frame::Video::empty();
                conv.run(&frame, &mut converted)
                    .map_err(|e| anyhow!("video sws_scale: {e:?}"))?;
                converted.set_pts(frame.pts());
                converted
            } else {
                frame
            }
        } else {
            // No converter configured: the caller is responsible for
            // handing us frames already in the encoder's format.
            frame
        };

        self.encoder
            .send_frame(&frame_to_send)
            .map_err(|e| anyhow!("video send_frame: {e:?}"))?;
        self.drain(output)
    }

    /// A frame of another size than the encoder's, scaled to fit and
    /// letterboxed, in the encoder's format.
    fn resize(&mut self, frame: frame::Video) -> Result<frame::Video> {
        let source = (frame.format(), frame.width(), frame.height());
        if frame.width() < 2 || frame.height() < 2 {
            bail!("video frame too small to scale: {}x{}", source.1, source.2);
        }
        let encoder_format = self.encoder.format();
        let letterbox = encoder_format == Pixel::NV12;
        if self.resizer.as_ref().map(|r| r.source) != Some(source) {
            let fit = if letterbox {
                fit_rect(source.1, source.2, self.width, self.height)
            } else {
                FitRect {
                    x: 0,
                    y: 0,
                    width: self.width,
                    height: self.height,
                }
            };
            let scaler = software::scaling::Context::get(
                source.0,
                source.1,
                source.2,
                encoder_format,
                fit.width,
                fit.height,
                // FAST_BILINEAR visibly aliases text when downscaling.
                software::scaling::flag::Flags::BILINEAR,
            )
            .map_err(|e| anyhow!("video resize init {}x{}: {e:?}", source.1, source.2))?;
            tracing::warn!(
                frame_width = source.1,
                frame_height = source.2,
                encoder_width = self.width,
                encoder_height = self.height,
                "video frame size differs from the encoder's; scaling to fit"
            );
            self.resizer = Some(FrameResizer {
                source,
                fit,
                scaler,
            });
        }
        let resizer = self.resizer.as_mut().expect("resizer built above");
        let mut scaled = frame::Video::empty();
        resizer
            .scaler
            .run(&frame, &mut scaled)
            .map_err(|e| anyhow!("video resize sws_scale: {e:?}"))?;
        let mut out = if letterbox {
            letterbox_nv12(&scaled, self.width, self.height, resizer.fit)
        } else {
            scaled
        };
        out.set_pts(frame.pts());
        self.rescaled_frames += 1;
        Ok(out)
    }

    fn drain(&mut self, output: &mut format::context::Output) -> Result<()> {
        while self.encoder.receive_packet(&mut self.packet).is_ok() {
            self.packet.set_stream(self.stream_index);
            // Encoder emits packets in the encoder's time base; the muxer
            // wants them in the stream's time base.
            self.packet.rescale_ts(
                self.time_base,
                output
                    .stream(self.stream_index)
                    .ok_or_else(|| anyhow!("video stream missing"))?
                    .time_base(),
            );
            self.packet
                .write_interleaved(output)
                .map_err(|e| anyhow!("video write_interleaved: {e:?}"))?;
        }
        Ok(())
    }

    fn flush(&mut self, output: &mut format::context::Output) -> Result<()> {
        self.encoder
            .send_eof()
            .map_err(|e| anyhow!("video send_eof: {e:?}"))?;
        self.drain(output)
    }
}

fn pick_video_codec(cfg: &Config) -> (Codec, Dictionary<'static>) {
    let mut options = Dictionary::new();

    if let Some(codec) = encoder::find_by_name("h264_videotoolbox") {
        // Real-time mode = encoder picks lower latency over absolute
        // best quality. Right tradeoff for live screen recording.
        options.set("realtime", "true");
        options.set("constant_bit_rate", "false");
        // Long-term reference frames help quality at the same bitrate
        // but cost the encoder a bit; safe to leave default.
        return (codec, options);
    }

    if let Some(codec) = encoder::find_by_name("libx264") {
        let keyint = (cfg.fps * 2).to_string();
        options.set("preset", "ultrafast");
        options.set("tune", "zerolatency");
        options.set("g", &keyint);
        options.set("keyint_min", &keyint);
        return (codec, options);
    }

    panic!(
        "no H.264 encoder available (looked for h264_videotoolbox, libx264). \
         Reinstall ffmpeg with --enable-videotoolbox or --enable-libx264."
    );
}

fn constrained_vbr_max_bitrate(average_bps: usize) -> usize {
    average_bps.saturating_mul(3) / 2
}

// ---------------------------------------------------------------------------
// Audio lane
// ---------------------------------------------------------------------------

impl AudioLane {
    fn open(output: &mut format::context::Output, global_header: bool) -> Result<Self> {
        let codec = encoder::find_by_name("aac")
            .ok_or_else(|| anyhow!("aac encoder not available in this ffmpeg build"))?;
        let mut encoder_ctx = codec::context::Context::new_with_codec(codec);
        encoder_ctx.set_threading(codec::threading::Config::count(2));

        let mut audio_encoder = encoder_ctx.encoder().audio()?;
        if global_header {
            audio_encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        audio_encoder.set_rate(SAMPLE_RATE);
        audio_encoder.set_format(Sample::F32(format::sample::Type::Planar));
        audio_encoder.set_channel_layout(ffmpeg::ChannelLayout::STEREO);
        audio_encoder.set_bit_rate(320_000);
        audio_encoder.set_time_base(Rational::new(1, SAMPLE_RATE));

        let audio_encoder = audio_encoder
            .open()
            .map_err(|e| anyhow!("audio encoder open: {e:?}"))?;
        let frame_size = audio_encoder.frame_size() as usize;
        if frame_size == 0 {
            bail!("AAC encoder reported a zero frame_size");
        }

        let mut stream = output.add_stream(codec)?;
        let stream_index = stream.index();
        stream.set_time_base(Rational::new(1, SAMPLE_RATE));
        stream.set_parameters(&audio_encoder);

        Ok(Self {
            encoder: audio_encoder,
            stream_index,
            time_base: Rational::new(1, SAMPLE_RATE),
            packet: ffmpeg::Packet::empty(),
            buffer: AudioFrameBuffer::new(frame_size),
        })
    }

    fn queue(&mut self, output: &mut format::context::Output, frame: frame::Audio) -> Result<()> {
        self.buffer.push(frame)?;
        self.drain_buffered(output)
    }

    /// Append silence up to `target_pts` (samples since the start) and encode
    /// every full frame it completes. A no-op when audio already reaches it.
    fn pad_silence_to(
        &mut self,
        output: &mut format::context::Output,
        target_pts: i64,
    ) -> Result<()> {
        // A long gap (a Windows take resumed after a long pause, whose video
        // PTS includes the paused time) is appended and encoded one second at
        // a time, so it never holds more than a second of PCM in memory.
        loop {
            let next = self.buffer.next_sample_pts.unwrap_or(0);
            if target_pts <= next {
                return Ok(());
            }
            let chunk = usize::try_from((target_pts - next).min(SILENCE_PAD_CHUNK_SAMPLES))
                .map_err(|_| anyhow!("silence gap is out of range: target={target_pts} next={next}"))?;
            self.buffer.append_silence(chunk);
            self.drain_buffered(output)?;
        }
    }

    fn drain_buffered(&mut self, output: &mut format::context::Output) -> Result<()> {
        while let Some(frame) = self.buffer.pop_full_frame() {
            self.send_frame(output, &frame)?;
        }
        Ok(())
    }

    fn send_frame(
        &mut self,
        output: &mut format::context::Output,
        frame: &frame::Audio,
    ) -> Result<()> {
        self.encoder
            .send_frame(frame)
            .map_err(|e| anyhow!("audio send_frame: {e:?}"))?;
        self.drain(output)
    }

    fn drain(&mut self, output: &mut format::context::Output) -> Result<()> {
        while self.encoder.receive_packet(&mut self.packet).is_ok() {
            self.packet.set_stream(self.stream_index);
            self.packet.rescale_ts(
                self.time_base,
                output
                    .stream(self.stream_index)
                    .ok_or_else(|| anyhow!("audio stream missing"))?
                    .time_base(),
            );
            self.packet
                .write_interleaved(output)
                .map_err(|e| anyhow!("audio write_interleaved: {e:?}"))?;
        }
        Ok(())
    }

    fn flush(&mut self, output: &mut format::context::Output) -> Result<()> {
        self.drain_buffered(output)?;
        if let Some(frame) = self.buffer.pop_partial_frame() {
            self.send_frame(output, &frame)?;
        }
        self.encoder
            .send_eof()
            .map_err(|e| anyhow!("audio send_eof: {e:?}"))?;
        self.drain(output)
    }
}

struct AudioFrameBuffer {
    channels: Vec<VecDeque<f32>>,
    frame_size: usize,
    buffer_start_pts: Option<i64>,
    next_sample_pts: Option<i64>,
}

impl AudioFrameBuffer {
    fn new(frame_size: usize) -> Self {
        Self {
            channels: vec![VecDeque::new(); AUDIO_CHANNELS as usize],
            frame_size,
            buffer_start_pts: None,
            next_sample_pts: None,
        }
    }

    fn push(&mut self, frame: frame::Audio) -> Result<()> {
        if frame.samples() == 0 {
            return Ok(());
        }
        self.validate_frame(&frame)?;

        let pts = frame
            .pts()
            .ok_or_else(|| anyhow!("audio frame missing pts"))?;
        let expected = *self.next_sample_pts.get_or_insert(pts);
        let mut skip = 0usize;

        if pts > expected {
            let gap = usize::try_from(pts - expected).map_err(|_| {
                anyhow!("audio pts gap is too large: pts={pts} expected={expected}")
            })?;
            self.append_silence(gap);
        } else if pts < expected {
            skip = usize::try_from(expected - pts).map_err(|_| {
                anyhow!("audio pts overlap is too large: pts={pts} expected={expected}")
            })?;
            if skip >= frame.samples() {
                return Ok(());
            }
        }

        self.append_frame_samples(&frame, skip);
        Ok(())
    }

    fn validate_frame(&self, frame: &frame::Audio) -> Result<()> {
        let expected_format = Sample::F32(format::sample::Type::Planar);
        if frame.format() != expected_format {
            bail!(
                "audio frame format mismatch: got {:?}, expected {:?}",
                frame.format(),
                expected_format
            );
        }
        if frame.rate() != SAMPLE_RATE as u32 {
            bail!(
                "audio frame sample rate mismatch: got {}, expected {}",
                frame.rate(),
                SAMPLE_RATE
            );
        }
        if frame.channel_layout() != ChannelLayout::STEREO
            || frame.channels() != AUDIO_CHANNELS
            || frame.planes() != AUDIO_CHANNELS as usize
        {
            bail!(
                "audio frame channel layout mismatch: layout={:?} channels={} planes={}",
                frame.channel_layout(),
                frame.channels(),
                frame.planes()
            );
        }
        Ok(())
    }

    fn append_silence(&mut self, samples: usize) {
        if samples == 0 {
            return;
        }

        let start = self.next_sample_pts.unwrap_or(0);
        self.ensure_buffer_start(start);
        for plane in &mut self.channels {
            plane.extend(std::iter::repeat(0.0).take(samples));
        }
        self.next_sample_pts = Some(start + samples as i64);
    }

    fn append_frame_samples(&mut self, frame: &frame::Audio, skip: usize) {
        let samples_to_append = frame.samples() - skip;
        let start = self
            .next_sample_pts
            .unwrap_or_else(|| frame.pts().unwrap_or(0));
        self.ensure_buffer_start(start);

        for channel in 0..self.channels.len() {
            let plane = frame.plane::<f32>(channel);
            self.channels[channel].extend(plane[skip..].iter().copied());
        }

        self.next_sample_pts = Some(start + samples_to_append as i64);
    }

    fn ensure_buffer_start(&mut self, pts: i64) {
        if self.buffer_start_pts.is_none() {
            self.buffer_start_pts = Some(pts);
        }
    }

    fn buffered_samples(&self) -> usize {
        self.channels.first().map_or(0, VecDeque::len)
    }

    fn pop_full_frame(&mut self) -> Option<frame::Audio> {
        if self.frame_size == 0 || self.buffered_samples() < self.frame_size {
            return None;
        }
        self.pop_frame(self.frame_size)
    }

    fn pop_partial_frame(&mut self) -> Option<frame::Audio> {
        let samples = self.buffered_samples();
        if samples == 0 {
            return None;
        }
        self.pop_frame(samples.min(self.frame_size.max(1)))
    }

    fn pop_frame(&mut self, samples: usize) -> Option<frame::Audio> {
        let pts = self.buffer_start_pts?;
        let mut out = frame::Audio::new(
            Sample::F32(format::sample::Type::Planar),
            samples,
            ChannelLayout::STEREO,
        );
        out.set_rate(SAMPLE_RATE as u32);
        out.set_pts(Some(pts));

        for channel in 0..self.channels.len() {
            let dst = out.plane_mut::<f32>(channel);
            for sample in dst.iter_mut() {
                *sample = self.channels[channel].pop_front().unwrap_or(0.0);
            }
        }

        if self.buffered_samples() == 0 {
            self.buffer_start_pts = None;
        } else {
            self.buffer_start_pts = Some(pts + samples as i64);
        }

        Some(out)
    }
}

// ---------------------------------------------------------------------------
// SCK CMSampleBuffer → ffmpeg::frame conversion (macOS only)
// ---------------------------------------------------------------------------
//
// Direct port of Cap.so's `crates/scap-ffmpeg/src/screencapturekit.rs`.
// SCK delivers BGRA-32 pixel buffers on macOS 13 and later, the hot path.
// On macOS 12 the stream asks for 420v (`capture/macos.rs`
// `StreamFormat`), which arrives here as NV12. Cap's helper trait + RAII
// lock guard is reproduced here because cidre's own `BaseAddrLockGuard`
// doesn't expose `plane_data()`.

/// RAII wrapper around `CVPixelBufferLockBaseAddress` that exposes the
/// per-plane byte slice while the lock is held. Drop releases the lock.
#[cfg(target_os = "macos")]
struct PixelLockGuard<'a> {
    buf: &'a mut cv::PixelBuf,
    flags: cv::pixel_buffer::LockFlags,
}

#[cfg(target_os = "macos")]
impl<'a> PixelLockGuard<'a> {
    fn lock(buf: &'a mut cv::PixelBuf, flags: cv::pixel_buffer::LockFlags) -> Result<Self> {
        unsafe { buf.lock_base_addr(flags) }
            .result()
            .map_err(|e| anyhow!("CVPixelBufferLockBaseAddress: {e:?}"))?;
        Ok(Self { buf, flags })
    }

    fn plane_data(&self, index: usize) -> &[u8] {
        let base = self.buf.plane_base_address(index);
        let stride = self.buf.plane_bytes_per_row(index);
        let height = self.buf.plane_height(index);
        // Safe: CV plane buffers are size = stride * height bytes; CV holds
        // the lock until Drop runs.
        unsafe { std::slice::from_raw_parts(base, stride * height) }
    }
}

#[cfg(target_os = "macos")]
impl<'a> Drop for PixelLockGuard<'a> {
    fn drop(&mut self) {
        let _ = unsafe { self.buf.unlock_lock_base_addr(self.flags) };
    }
}

/// Convert SCK's video CMSampleBuffer into an `ffmpeg::frame::Video`,
/// stamped with the supplied PTS in the encoder's video time base
/// (`(1, VIDEO_TIME_BASE)`). Always copies the pixel rows — SCK's
/// CVPixelBuffer is recycled by the dispatch queue and we can't keep
/// references to it past this call.
#[cfg(target_os = "macos")]
pub fn cm_video_to_frame(sbuf: &cm::SampleBuf, pts_us: i64) -> Result<frame::Video> {
    let img_buf = sbuf
        .image_buf()
        .ok_or_else(|| anyhow!("video sample buf has no image buf"))?;
    let mut img_buf = img_buf.retained();
    let width = img_buf.width();
    let height = img_buf.height();
    if width == 0 || height == 0 {
        bail!("video sample buf has zero dimensions");
    }

    let format = img_buf.pixel_format();
    let lock = PixelLockGuard::lock(img_buf.as_mut(), cv::pixel_buffer::LockFlags::READ_ONLY)?;

    match format {
        cv::PixelFormat::_32_BGRA => {
            let mut ff = frame::Video::new(Pixel::BGRA, width as u32, height as u32);
            let src = lock.plane_data(0);
            let src_stride = lock.buf.plane_bytes_per_row(0);
            let dst_stride = ff.stride(0);
            let row_bytes = width * 4;
            let dst = ff.data_mut(0);
            for y in 0..height {
                let s = y * src_stride;
                let d = y * dst_stride;
                dst[d..d + row_bytes].copy_from_slice(&src[s..s + row_bytes]);
            }
            ff.set_pts(Some(pts_us));
            Ok(ff)
        }
        cv::PixelFormat::_420V | cv::PixelFormat::_420F => {
            let mut ff = frame::Video::new(Pixel::NV12, width as u32, height as u32);

            // Y plane.
            {
                let src = lock.plane_data(0);
                let src_stride = lock.buf.plane_bytes_per_row(0);
                let dst_stride = ff.stride(0);
                let dst = ff.data_mut(0);
                for y in 0..height {
                    let s = y * src_stride;
                    let d = y * dst_stride;
                    dst[d..d + width].copy_from_slice(&src[s..s + width]);
                }
            }
            // UV plane (interleaved, half height in NV12).
            {
                let src = lock.plane_data(1);
                let src_stride = lock.buf.plane_bytes_per_row(1);
                let dst_stride = ff.stride(1);
                let dst = ff.data_mut(1);
                // An odd-sized buffer (only possible when SCK sends a size
                // other than the configured one) still has a chroma sample
                // for its last column and row: round both up, within what
                // either plane holds.
                let row_bytes = ((width + 1) & !1).min(src_stride).min(dst_stride);
                let rows = ((height + 1) / 2)
                    .min(lock.buf.plane_height(1))
                    .min(dst.len() / dst_stride.max(1));
                for y in 0..rows {
                    let s = y * src_stride;
                    let d = y * dst_stride;
                    dst[d..d + row_bytes].copy_from_slice(&src[s..s + row_bytes]);
                }
            }
            ff.set_pts(Some(pts_us));
            Ok(ff)
        }
        other => bail!("unsupported SCK pixel format: {other:?}"),
    }
}

/// Convert SCK's system-audio CMSampleBuffer into an `ffmpeg::frame::Audio`
/// (planar f32 stereo @ 48 kHz), stamped with the supplied PTS in the
/// encoder's audio time base (`(1, SAMPLE_RATE)`).
#[cfg(target_os = "macos")]
pub fn cm_audio_to_frame(sbuf: &cm::SampleBuf, pts: i64) -> Result<frame::Audio> {
    let format_desc = sbuf
        .format_desc()
        .ok_or_else(|| anyhow!("audio sample buf has no format desc"))?;
    let asbd = format_desc
        .stream_basic_desc()
        .ok_or_else(|| anyhow!("audio sample buf has no stream basic desc"))?;
    if !asbd
        .format_flags
        .contains(cat::audio::FormatFlags::IS_FLOAT)
        || asbd.bits_per_channel != 32
    {
        bail!(
            "unsupported SCK audio format: flags={:?} bits_per_channel={}",
            asbd.format_flags,
            asbd.bits_per_channel
        );
    }
    let sample_rate = asbd.sample_rate.round() as i32;
    if sample_rate != SAMPLE_RATE {
        bail!(
            "SCK audio sample rate mismatch: got {}, expected {}",
            sample_rate,
            SAMPLE_RATE
        );
    }

    // CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer with 16-byte
    // alignment. Depending on the ASBD, macOS may return one packed stereo
    // buffer or one mono buffer per channel; normalize both forms to planar
    // f32 stereo before the AAC lane batches exact encoder-sized frames.
    let buf_list = sbuf
        .audio_buf_list::<2>()
        .map_err(|e| anyhow!("audio_buf_list (sys audio): {e:?}"))?;
    let list = buf_list.list();
    let number_buffers = list.number_buffers as usize;
    if number_buffers == 0 {
        bail!("SCK audio buffer list has no buffers");
    }

    let num_samples = sbuf.num_samples().max(1) as usize;
    let input_channels = asbd.channels_per_frame.max(1) as usize;

    let mut ff = frame::Audio::new(
        Sample::F32(format::sample::Type::Planar),
        num_samples,
        ChannelLayout::STEREO,
    );
    ff.set_rate(SAMPLE_RATE as u32);

    if asbd.is_interleaved() {
        let src = audio_buffer_bytes(&list.buffers[0]);
        let expected_bytes = num_samples
            .checked_mul(input_channels)
            .and_then(|n| n.checked_mul(std::mem::size_of::<f32>()))
            .ok_or_else(|| anyhow!("SCK interleaved audio byte count overflow"))?;
        if src.len() < expected_bytes {
            bail!(
                "SCK interleaved audio buffer too small: got {} bytes, expected at least {}",
                src.len(),
                expected_bytes
            );
        }

        for out_channel in 0..AUDIO_CHANNELS as usize {
            let src_channel = if input_channels == 1 {
                0
            } else {
                out_channel.min(input_channels - 1)
            };
            let dst = ff.plane_mut::<f32>(out_channel);
            for (sample_idx, sample) in dst.iter_mut().take(num_samples).enumerate() {
                let interleaved_idx = sample_idx * input_channels + src_channel;
                *sample = read_f32_sample(src, interleaved_idx)?;
            }
        }
    } else {
        for out_channel in 0..AUDIO_CHANNELS as usize {
            let src_channel = if input_channels == 1 {
                0
            } else {
                out_channel.min(input_channels - 1)
            };
            if src_channel >= number_buffers {
                bail!(
                    "SCK non-interleaved audio missing channel {} (buffers={})",
                    src_channel,
                    number_buffers
                );
            }

            let src = audio_buffer_bytes(&list.buffers[src_channel]);
            let expected_bytes = num_samples
                .checked_mul(std::mem::size_of::<f32>())
                .ok_or_else(|| anyhow!("SCK planar audio byte count overflow"))?;
            if src.len() < expected_bytes {
                bail!(
                    "SCK planar audio buffer too small: got {} bytes, expected at least {}",
                    src.len(),
                    expected_bytes
                );
            }

            let dst = ff.plane_mut::<f32>(out_channel);
            for (sample_idx, sample) in dst.iter_mut().take(num_samples).enumerate() {
                *sample = read_f32_sample(src, sample_idx)?;
            }
        }
    }

    ff.set_pts(Some(pts));
    Ok(ff)
}

#[cfg(target_os = "macos")]
fn audio_buffer_bytes(buf: &cat::audio::Buf) -> &[u8] {
    unsafe { std::slice::from_raw_parts(buf.data, buf.data_bytes_size as usize) }
}

#[cfg(target_os = "macos")]
fn read_f32_sample(bytes: &[u8], sample_idx: usize) -> Result<f32> {
    let start = sample_idx
        .checked_mul(std::mem::size_of::<f32>())
        .ok_or_else(|| anyhow!("audio sample index overflow"))?;
    let end = start + std::mem::size_of::<f32>();
    if end > bytes.len() {
        bail!(
            "audio sample {} out of bounds: end={} len={}",
            sample_idx,
            end,
            bytes.len()
        );
    }
    Ok(f32::from_ne_bytes(bytes[start..end].try_into().unwrap()))
}

// ---------------------------------------------------------------------------
// Encoder unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constrained_vbr_allows_fifty_percent_peak_headroom() {
        assert_eq!(constrained_vbr_max_bitrate(3_500_000), 5_250_000);
    }

    #[test]
    fn fit_rect_keeps_aspect_ratio_and_even_values() {
        // Same aspect ratio: fills the frame.
        assert_eq!(
            fit_rect(2880, 1800, 1152, 720),
            FitRect {
                x: 0,
                y: 0,
                width: 1152,
                height: 720
            }
        );
        // Wider source: bars top and bottom.
        assert_eq!(
            fit_rect(1920, 1080, 1152, 720),
            FitRect {
                x: 0,
                y: 36,
                width: 1152,
                height: 648
            }
        );
        // Taller source: bars left and right.
        let fit = fit_rect(1080, 1920, 1280, 720);
        assert_eq!((fit.height, fit.y), (720, 0));
        assert_eq!(fit.width % 2, 0);
        assert_eq!(fit.x % 2, 0);
        assert!(fit.x + fit.width <= 1280);
        // Degenerate input never yields a zero-sized rect.
        let tiny = fit_rect(1, 10_000, 640, 360);
        assert!(tiny.width >= 2 && tiny.height >= 2);
    }

    #[test]
    fn letterbox_places_the_frame_inside_black_bars() {
        let mut src = frame::Video::new(Pixel::NV12, 4, 2);
        src.data_mut(0).fill(200);
        src.data_mut(1).fill(90);
        let fit = FitRect {
            x: 2,
            y: 2,
            width: 4,
            height: 2,
        };
        let out = letterbox_nv12(&src, 8, 6, fit);
        assert_eq!((out.width(), out.height()), (8, 6));
        let y_stride = out.stride(0);
        let y = out.data(0);
        assert_eq!(y[0], 16);
        assert_eq!(y[2 * y_stride + 2], 200);
        assert_eq!(y[3 * y_stride + 5], 200);
        assert_eq!(y[3 * y_stride + 6], 16);
        assert_eq!(y[4 * y_stride + 2], 16);
        let uv_stride = out.stride(1);
        let uv = out.data(1);
        assert_eq!(uv[0], 128);
        assert_eq!(uv[uv_stride + 2], 90);
        assert_eq!(uv[uv_stride + 6], 128);
    }
}

// Smoke tests for the macOS encoder setup.
#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;

    /// Black NV12 frame at PTS, ready to feed straight to the encoder.
    fn black_nv12_frame(width: u32, height: u32, pts_us: i64) -> frame::Video {
        let mut f = frame::Video::new(Pixel::NV12, width, height);
        // Y plane = 16 (limited-range black), UV plane = 128 (chroma neutral).
        f.data_mut(0).fill(16);
        f.data_mut(1).fill(128);
        f.set_pts(Some(pts_us));
        f
    }

    /// 1024-sample silent planar f32 stereo frame at PTS.
    fn silent_audio_frame(samples: usize, pts: i64) -> frame::Audio {
        let mut f = frame::Audio::new(
            Sample::F32(format::sample::Type::Planar),
            samples,
            ffmpeg::ChannelLayout::STEREO,
        );
        f.set_rate(SAMPLE_RATE as u32);
        for plane in 0..2 {
            f.data_mut(plane).fill(0);
        }
        f.set_pts(Some(pts));
        f
    }

    #[test]
    fn frames_of_another_size_are_scaled_not_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resize.mp4");
        let cfg = Config {
            width: 640,
            height: 360,
            fps: 30,
            video_bitrate_bps: 1_500_000,
        };
        let mut enc = Mp4Encoder::open(&path, cfg).expect("open encoder");
        // The configured size, then a larger one (a display that changed
        // mode mid-take), then BGRA at yet another size.
        enc.queue_video(black_nv12_frame(640, 360, 0))
            .expect("same size");
        enc.queue_video(black_nv12_frame(1280, 800, 33_333))
            .expect("larger NV12");
        let mut bgra = frame::Video::new(Pixel::BGRA, 800, 600);
        bgra.set_pts(Some(66_666));
        enc.queue_video(bgra).expect("BGRA of another size");
        assert_eq!(enc.rescaled_video_frames(), 2);
        enc.finish().expect("finish");
    }

    #[test]
    fn smoke_encodes_fragmented_mp4() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("smoke.mp4");

        let cfg = Config {
            width: 640,
            height: 360,
            fps: 30,
            video_bitrate_bps: 1_500_000,
        };
        let mut enc = Mp4Encoder::open(&path, cfg).expect("open encoder");

        // ~1 second of black video + matching silent audio.
        for i in 0..30i64 {
            let pts = i * (VIDEO_TIME_BASE as i64 / 30);
            enc.queue_video(black_nv12_frame(cfg.width, cfg.height, pts))
                .expect("queue_video");
        }

        let frame_size = 1024;
        let total_audio_frames = SAMPLE_RATE as usize / frame_size; // ~46 of 1024 in 1s
        for i in 0..total_audio_frames as i64 {
            let pts = i * frame_size as i64;
            enc.queue_audio(silent_audio_frame(frame_size, pts))
                .expect("queue_audio");
        }

        enc.finish().expect("finish");

        // Verify the file is a fragmented MP4: starts with `ftyp` at byte 4,
        // contains at least one `moof` box, contains the empty `moov` header.
        let bytes = std::fs::read(&path).expect("read smoke.mp4");
        eprintln!("smoke.mp4 produced {} bytes", bytes.len());
        assert!(
            bytes.len() > 1024,
            "encoded file should be > 1 KiB; got {}",
            bytes.len()
        );
        assert_eq!(&bytes[4..8], b"ftyp", "file must start with an ftyp box");
        assert!(
            bytes.windows(4).any(|w| w == b"moof"),
            "fragmented MP4 must contain at least one moof box"
        );
        assert!(
            bytes.windows(4).any(|w| w == b"moov"),
            "MP4 must contain a moov box"
        );

        // Hand the file to ffprobe — if it can demux video + audio
        // streams cleanly, we're confident the muxer output is sound.
        let pinned = std::path::Path::new("/opt/homebrew/opt/ffmpeg@7/bin/ffprobe");
        let ffprobe_bin = if pinned.exists() { pinned.as_os_str() } else { std::ffi::OsStr::new("ffprobe") };
        let ffprobe = std::process::Command::new(ffprobe_bin)
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name,width,height,sample_rate",
                "-of",
                "default=noprint_wrappers=1",
            ])
            .arg(&path)
            .output()
            .expect("invoke ffprobe");
        let stdout = String::from_utf8_lossy(&ffprobe.stdout);
        let stderr = String::from_utf8_lossy(&ffprobe.stderr);
        eprintln!("ffprobe stdout:\n{stdout}");
        if !stderr.is_empty() {
            eprintln!("ffprobe stderr:\n{stderr}");
        }
        assert!(
            stdout.contains("codec_name=h264"),
            "ffprobe didn't see h264 stream"
        );
        assert!(
            stdout.contains("codec_name=aac"),
            "ffprobe didn't see aac stream"
        );
    }

    /// The streaming uploader tails this file while recording — bytes must
    /// reach the disk *during* the encode, not only at finish(). Feeds 6 s
    /// of interleaved video+audio (mimicking the live pump's arrival order)
    /// and asserts the file has grown well past the fMP4 header before the
    /// trailer is written.
    #[test]
    fn fragments_flush_to_disk_during_encode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live-flush.mp4");

        let cfg = Config {
            width: 640,
            height: 360,
            fps: 30,
            video_bitrate_bps: 1_500_000,
        };
        let mut enc = Mp4Encoder::open(&path, cfg).expect("open encoder");

        let file_size = |label: &str| -> u64 {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            eprintln!("on-disk size {label}: {size} bytes");
            size
        };
        let header_size = file_size("after header");

        // Noise frames so the encoder emits realistic bitrate — black
        // frames compress to ~nothing and the whole test output would fit
        // inside libavformat's 32 KiB avio buffer, masking the result.
        let mut rng_state = 0x12345678u32;
        let mut noise_nv12_frame = |width: u32, height: u32, pts_us: i64| -> frame::Video {
            let mut f = frame::Video::new(Pixel::NV12, width, height);
            for byte in f.data_mut(0).iter_mut() {
                rng_state = rng_state.wrapping_mul(1664525).wrapping_add(1013904223);
                *byte = (rng_state >> 24) as u8;
            }
            f.data_mut(1).fill(128);
            f.set_pts(Some(pts_us));
            f
        };

        let frame_size = 1024usize;
        let audio_frames_per_sec = SAMPLE_RATE as usize / frame_size;
        let mut sizes_per_sec = Vec::new();
        for sec in 0..6i64 {
            for i in 0..30i64 {
                let n = sec * 30 + i;
                let video_pts = n * (VIDEO_TIME_BASE as i64 / 30);
                enc.queue_video(noise_nv12_frame(cfg.width, cfg.height, video_pts))
                    .expect("queue_video");
                // ~1.5 audio frames per video frame keeps both lanes fed in
                // arrival order, like the real pump.
                let a0 = (n * audio_frames_per_sec as i64) / 30;
                let a1 = ((n + 1) * audio_frames_per_sec as i64) / 30;
                for a in a0..a1 {
                    enc.queue_audio(silent_audio_frame(frame_size, a * frame_size as i64))
                        .expect("queue_audio");
                }
            }
            sizes_per_sec.push(file_size(&format!("after {}s", sec + 1)));
        }

        let mid_encode = *sizes_per_sec.last().unwrap();
        enc.finish().expect("finish");
        let final_size = file_size("after finish");
        let bytes = std::fs::read(&path).expect("read output");
        let moof_count = bytes.windows(4).filter(|w| *w == b"moof").count();
        eprintln!("moof fragments in final file: {moof_count}");

        // frag_duration=1s → roughly one fragment per second of media.
        // After 6 s of media at 1.5 Mbps, most of the encode must already
        // be on disk. If this fails, the muxer is buffering until the
        // trailer and "streaming upload during recording" is fiction.
        assert!(
            mid_encode > header_size + 500 * 1024,
            "expected ≥500 KiB of fragments on disk mid-encode; header={header_size}, \
             mid-encode={mid_encode}, final={final_size}"
        );
        assert!(
            moof_count >= 5,
            "frag_duration=1s should cut ~6 fragments over 6 s of media; got {moof_count}"
        );
        // Upload latency = fragment cadence: bytes must start landing
        // within the first 2 s of media, not pool until a 2 s GOP closes.
        assert!(
            sizes_per_sec[1] > header_size,
            "no bytes on disk after 2 s of media — fragment cadence regressed \
             (sizes per second: {sizes_per_sec:?})"
        );
        // And keep landing: at least 4 of the 6 one-second checkpoints
        // must show growth over their predecessor.
        let growth_steps = sizes_per_sec
            .windows(2)
            .filter(|pair| pair[1] > pair[0])
            .count();
        assert!(
            growth_steps >= 3,
            "expected steady per-second growth; sizes: {sizes_per_sec:?}"
        );
    }

    /// A take where no audio frame ever arrives must not end with a
    /// zero-packet audio track (seen on Windows).
    #[test]
    fn silence_prefill_fills_audio_track_when_no_audio_arrives() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("silent-prefill.mp4");
        let cfg = Config {
            width: 640,
            height: 360,
            fps: 30,
            video_bitrate_bps: 1_500_000,
        };
        let frame_us = VIDEO_TIME_BASE as i64 / 30;
        let mut enc = Mp4Encoder::open(&path, cfg).expect("open encoder");
        enc.enable_silence_prefill();
        for i in 0..90i64 {
            enc.queue_video(black_nv12_frame(cfg.width, cfg.height, i * frame_us))
                .expect("queue_video");
        }
        // While recording, silence trails the newest video frame.
        let last_us = 89 * frame_us;
        assert_eq!(
            enc.audio.buffer.next_sample_pts,
            Some((last_us - SILENCE_PREFILL_LAG_US) * SAMPLE_RATE as i64 / VIDEO_TIME_BASE as i64),
        );
        enc.finish().expect("finish");
        // At finish it reaches the end of the video.
        assert_eq!(
            enc.audio.buffer.next_sample_pts,
            Some((last_us + frame_us) * SAMPLE_RATE as i64 / VIDEO_TIME_BASE as i64),
        );
    }

    #[test]
    fn silence_prefill_pads_after_real_audio_stops_and_is_off_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config {
            width: 640,
            height: 360,
            fps: 30,
            video_bitrate_bps: 1_500_000,
        };
        let frame_us = VIDEO_TIME_BASE as i64 / 30;

        let mut plain = Mp4Encoder::open(&dir.path().join("plain.mp4"), cfg).expect("open");
        for i in 0..90i64 {
            plain
                .queue_video(black_nv12_frame(cfg.width, cfg.height, i * frame_us))
                .expect("queue_video");
        }
        assert_eq!(plain.audio.buffer.next_sample_pts, None);
        plain.finish().expect("finish");

        let mut enc = Mp4Encoder::open(&dir.path().join("real.mp4"), cfg).expect("open");
        enc.enable_silence_prefill();
        enc.queue_audio(silent_audio_frame(1024, 0)).expect("queue_audio");
        for i in 0..90i64 {
            enc.queue_video(black_nv12_frame(cfg.width, cfg.height, i * frame_us))
                .expect("queue_video");
        }
        // Real audio stopped after 1024 samples; silence carries the track
        // on behind the video instead of leaving it short.
        let last_us = 89 * frame_us;
        assert_eq!(
            enc.audio.buffer.next_sample_pts,
            Some((last_us - SILENCE_PREFILL_LAG_US) * SAMPLE_RATE as i64 / VIDEO_TIME_BASE as i64),
        );
        // Real audio inside the lag window still lands where it belongs.
        let at = enc.audio.buffer.next_sample_pts.unwrap();
        enc.queue_audio(silent_audio_frame(1024, at)).expect("queue_audio");
        assert_eq!(enc.audio.buffer.next_sample_pts, Some(at + 1024));
        enc.finish().expect("finish");
        assert_eq!(
            enc.audio.buffer.next_sample_pts,
            Some((last_us + frame_us) * SAMPLE_RATE as i64 / VIDEO_TIME_BASE as i64),
        );
    }

    /// A long gap is encoded in bounded pieces: after padding, no more than
    /// one AAC frame of silence is left buffered.
    #[test]
    fn silence_prefill_pads_a_long_gap_in_bounded_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config {
            width: 640,
            height: 360,
            fps: 30,
            video_bitrate_bps: 1_500_000,
        };
        let mut enc = Mp4Encoder::open(&dir.path().join("gap.mp4"), cfg).expect("open");
        enc.enable_silence_prefill();
        enc.queue_video(black_nv12_frame(cfg.width, cfg.height, 0))
            .expect("queue_video");
        // Ten minutes later, as after a long pause.
        let later_us = 600 * VIDEO_TIME_BASE as i64;
        enc.queue_video(black_nv12_frame(cfg.width, cfg.height, later_us))
            .expect("queue_video");
        assert_eq!(
            enc.audio.buffer.next_sample_pts,
            Some((later_us - SILENCE_PREFILL_LAG_US) * SAMPLE_RATE as i64 / VIDEO_TIME_BASE as i64),
        );
        let buffered = enc.audio.buffer.channels[0].len();
        assert!(
            buffered < enc.audio.buffer.frame_size,
            "only a partial frame may stay buffered, got {buffered} samples"
        );
        enc.finish().expect("finish");
    }

    #[test]
    fn smoke_accepts_variable_sized_audio_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("variable-audio.mp4");

        let cfg = Config {
            width: 640,
            height: 360,
            fps: 30,
            video_bitrate_bps: 1_500_000,
        };
        let mut enc = Mp4Encoder::open(&path, cfg).expect("open encoder");

        for i in 0..30i64 {
            let pts = i * (VIDEO_TIME_BASE as i64 / 30);
            enc.queue_video(black_nv12_frame(cfg.width, cfg.height, pts))
                .expect("queue_video");
        }

        let mut pts = 0i64;
        for samples in [
            512usize, 1536, 960, 2048, 128, 3000, 777, 1024, 2047, 4096, 333,
        ] {
            enc.queue_audio(silent_audio_frame(samples, pts))
                .expect("queue_audio");
            pts += samples as i64;
        }

        enc.finish().expect("finish");

        let bytes = std::fs::read(&path).expect("read variable-audio.mp4");
        assert!(
            bytes.windows(4).any(|w| w == b"moof"),
            "fragmented MP4 must contain at least one moof box"
        );
    }
}
