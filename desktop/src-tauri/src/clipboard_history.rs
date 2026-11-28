//! Clipboard history: remembers the text and images the user copies and opens
//! a picker (⇧⌘V on macOS, Ctrl+Shift+V on Windows, rebindable under
//! Shortcuts) that pastes an older item into the app they were in. Modeled on
//! ClipBook.
//!
//! Images follow ClipBook: when the clipboard holds a picture it is an image
//! item (with any text that came with it), stored as a PNG plus a small
//! thumbnail in `clipboard-images/`, labelled "Image (W×H)", and pasted back
//! as an image. The same picture copied again is one item, matched on its
//! pixels. A copied file is not an image, even when Finder adds its icon.
//!
//! History stays on this machine, in the app data folder, and is never
//! uploaded. Items a password manager marks as concealed or transient are
//! skipped, and the picker window is excluded from screen capture so a
//! recording never shows it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_store::StoreExt;

pub const ENABLED_KEY: &str = "clipboard_history_enabled";
pub const SHORTCUT_ACTION: &str = "clipboard_history";
const LABEL: &str = "clipboard";
const EVENT_CHANGED: &str = "clipboard-history-changed";
const EVENT_OPENED: &str = "clipboard-history-opened";
const FILE_NAME: &str = "clipboard-history.json";
const IMAGES_DIR: &str = "clipboard-images";
const THUMB_SUFFIX: &str = "-thumb.png";
/// How many items the history keeps, favorites aside. Past it the oldest go
/// first.
const MAX_ENTRIES: usize = 10_000;
/// Items older than this go, favorites aside: three months
/// back is no longer clipboard history. Checked on each copy, at launch and
/// when the picker opens.
const MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// What the text items may add up to, favorites aside. The whole history is
/// rewritten on each copy, so 10,000 items near `MAX_TEXT_BYTES` would mean
/// writing hundreds of MB per copy; past this the oldest text goes. Ten
/// thousand ordinary copies come to a few MB.
const MAX_TEXT_BYTES_TOTAL: usize = 25 * 1024 * 1024;
/// Larger copies (a whole log file, a minified bundle) are left out rather
/// than truncated: pasting half of something is worse than not offering it.
const MAX_TEXT_BYTES: usize = 50_000;
/// About 40 megapixels: a 6K display's screenshot fits with room to spare.
/// Anything larger is left out rather than decoded into a few hundred MB.
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
/// What the stored PNGs may take on disk together. ClipBook keeps every image
/// forever; past this the oldest images go first, text items stay.
const MAX_IMAGE_BYTES_TOTAL: u64 = 500 * 1024 * 1024;
/// Thumbnails fit this box: sharp for a picker grid card on a Retina screen.
/// Thumbnails stored before it grew are rebuilt the first time they are read.
const THUMB_SIZE: u32 = 480;
const POLL_INTERVAL: Duration = Duration::from_millis(400);
/// Windows refuses to open the clipboard while the copying app still holds
/// it, so a failed read is retried on the next few ticks.
const READ_ATTEMPTS: u32 = 3;
/// The picker's size before it is placed; `picker_size` sets the real one
/// from the display it opens on.
const WIDTH: f64 = 1100.0;
const HEIGHT: f64 = 680.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    pub id: u64,
    /// For an image item, the text copied with it (empty when there was none).
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ClipImage>,
    /// Favorites sit at the top of the picker and are never dropped to make
    /// room, nor by Clear all; only removing them, or turning history off,
    /// deletes them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
    pub copied_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipImage {
    /// SHA-256 of the size and pixels. It names the files in `IMAGES_DIR`,
    /// and two copies of the same picture are one item.
    pub hash: String,
    /// Pixels, not points: a Retina screenshot reads as its real size.
    pub width: u32,
    pub height: u32,
    /// Size of the stored PNG.
    pub bytes: u64,
}

impl ClipEntry {
    /// One item per image, matched on pixels; text items by their text.
    fn same_item(&self, other: &ClipEntry) -> bool {
        match (&self.image, &other.image) {
            (Some(a), Some(b)) => a.hash == b.hash,
            (None, None) => self.text == other.text,
            _ => false,
        }
    }
}

/// A copied image ready to keep: its entry data plus the bytes to store.
struct PreparedImage {
    info: ClipImage,
    png: Vec<u8>,
    thumb: Vec<u8>,
}

/// What the clipboard gave back for an image. PNG is kept as it is, so a
/// Retina screenshot keeps its resolution when pasted; a Windows `CF_DIB` is
/// decoded and stored as PNG.
enum RawImage {
    #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
    Png(Vec<u8>),
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Dib(Vec<u8>),
}

/// The image half of a clipboard read. `Busy` means an image is there but
/// the clipboard could not be opened yet (Windows, while the copying app
/// still holds it), so the whole item waits for the next tick rather than
/// being kept as text alone.
enum ImageRead {
    Missing,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Busy,
    Found(RawImage),
}

fn encode_png(pixels: &image::RgbaImage) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(pixels.as_raw(), pixels.width(), pixels.height(), image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(png)
}

/// The size is checked from the header, before any pixel is allocated.
fn decode_png(png: &[u8]) -> Option<image::RgbaImage> {
    use image::ImageDecoder;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_IMAGE_PIXELS * 8 + 16 * 1024 * 1024);
    let decoder = image::codecs::png::PngDecoder::with_limits(std::io::Cursor::new(png), limits).ok()?;
    let (width, height) = decoder.dimensions();
    if !image_fits(width, height) {
        return None;
    }
    image::DynamicImage::from_decoder(decoder).ok().map(|image| image.to_rgba8())
}

/// A `CF_DIB`: a bitmap info header and pixels, a BMP without its file header.
fn decode_dib(dib: &[u8]) -> Option<image::RgbaImage> {
    use image::ImageDecoder;
    let decoder = image::codecs::bmp::BmpDecoder::new_without_file_header(std::io::Cursor::new(dib)).ok()?;
    let (width, height) = decoder.dimensions();
    if !image_fits(width, height) {
        return None;
    }
    image::DynamicImage::from_decoder(decoder).ok().map(|image| image.to_rgba8())
}

fn image_fits(width: u32, height: u32) -> bool {
    width > 0 && height > 0 && width as u64 * height as u64 <= MAX_IMAGE_PIXELS
}

/// The size a PNG or `CF_DIB` header claims, read before the clipboard's
/// bytes are even copied, so an oversized image costs nothing. False when
/// the header is too short or unrecognised.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn header_fits(raw: &[u8], png: bool) -> bool {
    let u32_at = |at: usize, big_endian: bool| -> Option<u32> {
        let bytes: [u8; 4] = raw.get(at..at + 4)?.try_into().ok()?;
        Some(if big_endian { u32::from_be_bytes(bytes) } else { u32::from_le_bytes(bytes) })
    };
    let size = if png {
        if !raw.starts_with(b"\x89PNG\r\n\x1a\n") {
            return false;
        }
        u32_at(16, true).zip(u32_at(20, true))
    } else {
        match u32_at(0, false) {
            // BITMAPCOREHEADER: 16-bit width and height.
            Some(12) => raw.get(4..8).map(|b| {
                (u16::from_le_bytes([b[0], b[1]]) as u32, u16::from_le_bytes([b[2], b[3]]) as u32)
            }),
            // BITMAPINFOHEADER and later; a negative height means top-down rows.
            Some(_) => u32_at(4, false)
                .zip(u32_at(8, false))
                .map(|(w, h)| ((w as i32).unsigned_abs(), (h as i32).unsigned_abs())),
            None => None,
        }
    };
    size.is_some_and(|(width, height)| image_fits(width, height))
}

/// Hashes, thumbnails and (for a `CF_DIB`) encodes a copied image. `None` for an
/// empty or oversized picture, or one that does not decode.
fn prepare_image(raw: RawImage) -> Option<PreparedImage> {
    let (pixels, png) = match raw {
        RawImage::Png(png) => (decode_png(&png)?, Some(png)),
        RawImage::Dib(dib) => (decode_dib(&dib)?, None),
    };
    let (width, height) = pixels.dimensions();
    if !image_fits(width, height) {
        return None;
    }
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(pixels.as_raw());
    let hash = format!("{:x}", hasher.finalize());
    let thumb = make_thumb(&pixels)?;
    let png = match png {
        Some(png) => png,
        None => encode_png(&pixels)?,
    };
    Some(PreparedImage {
        info: ClipImage { hash, width, height, bytes: png.len() as u64 },
        png,
        thumb,
    })
}

fn make_thumb(pixels: &image::RgbaImage) -> Option<Vec<u8>> {
    let (width, height) = pixels.dimensions();
    let scale = (THUMB_SIZE as f64 / width.max(height) as f64).min(1.0);
    let thumb_width = ((width as f64 * scale).round() as u32).max(1);
    let thumb_height = ((height as f64 * scale).round() as u32).max(1);
    encode_png(&image::imageops::thumbnail(pixels, thumb_width, thumb_height))
}

/// Width and height from a PNG's header, without decoding it.
fn png_dimensions(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((width, height))
}

/// True when a stored thumbnail was made for a smaller box than today's, so
/// the picker's larger cards would show it blurred.
fn thumb_is_stale(thumb: &[u8], image: &ClipImage) -> bool {
    let wanted = THUMB_SIZE.min(image.width.max(image.height));
    png_dimensions(thumb).is_none_or(|(width, height)| width.max(height) < wanted)
}

fn image_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(format!("{hash}.png"))
}

fn thumb_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(format!("{hash}{THUMB_SUFFIX}"))
}

/// Written beside the target and renamed over it, so a crash never leaves a
/// half-written image under a name the history points at.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

/// The window that had focus before the picker opened, so the chosen item
/// goes back to it.
#[derive(Clone, Copy)]
pub(crate) enum PasteTarget {
    #[cfg(target_os = "macos")]
    Pid(i32),
    #[cfg(target_os = "windows")]
    Hwnd(isize),
}

pub struct ClipboardHistory {
    entries: Mutex<Vec<ClipEntry>>,
    path: Option<PathBuf>,
    enabled: AtomicBool,
    target: Mutex<Option<PasteTarget>>,
    /// Set instead of `target` when the picker opened over one of Clipy's own
    /// windows (Notes during a recording), which the platform target skips.
    own_window: Mutex<Option<String>>,
}

/// Puts the copy at the top. A repeat copy moves the old entry up instead of
/// adding a duplicate. Returns false when there is nothing worth keeping.
fn push_entry(entries: &mut Vec<ClipEntry>, text: String, image: Option<ClipImage>, now_ms: i64) -> bool {
    let text_fits = !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES;
    if image.is_none() && !text_fits {
        return false;
    }
    // Text riding with an image is kept only when it is worth pasting.
    let text = if text_fits { text } else { String::new() };
    let mut entry = ClipEntry { id: 0, text, image, favorite: false, copied_at: now_ms };
    if let Some(top) = entries.first_mut().filter(|top| top.same_item(&entry)) {
        // The same picture copied again with different text beside it: the
        // newest text is what pasting it should give back.
        let new_text = top.image.is_some() && top.text != entry.text;
        // A repeat copy is fresh use, so the age limit counts from it.
        if !new_text && top.copied_at >= now_ms {
            return false;
        }
        if new_text {
            top.text = entry.text;
        }
        top.copied_at = top.copied_at.max(now_ms);
        return true;
    }
    entry.id = next_id(entries);
    // A favorite copied again stays a favorite.
    entry.favorite = entries.iter().any(|e| e.favorite && e.same_item(&entry));
    entries.retain(|e| !e.same_item(&entry));
    entries.insert(0, entry);
    trim(entries, now_ms);
    true
}

fn next_id(entries: &[ClipEntry]) -> u64 {
    entries.iter().map(|e| e.id).max().unwrap_or(0) + 1
}

fn is_expired(entry: &ClipEntry, now_ms: i64) -> bool {
    !entry.favorite && now_ms.saturating_sub(entry.copied_at) > MAX_AGE_MS
}

/// Applies the age limit, the item cap, the text budget and the image disk
/// budget to everything but the favorites. Newest first, so what goes is the
/// oldest. The newest image is always kept: it is what the user just copied.
fn trim(entries: &mut Vec<ClipEntry>, now_ms: i64) {
    let mut kept = 0;
    let mut text_bytes = 0;
    let mut image_bytes = 0;
    let mut first_image = true;
    entries.retain(|e| {
        if e.favorite {
            return true;
        }
        if is_expired(e, now_ms) || kept == MAX_ENTRIES {
            return false;
        }
        // Only what is kept counts, so a dropped item does not take older
        // images or smaller text with it. The newest item always stays: it is
        // what the user just copied, and it is under `MAX_TEXT_BYTES` already.
        let text_after = text_bytes + e.text.len();
        if kept > 0 && text_after > MAX_TEXT_BYTES_TOTAL {
            return false;
        }
        // An image past the budget goes on its own and takes no slot, so the
        // text items behind it are not dropped early.
        if let Some(image) = &e.image {
            image_bytes += image.bytes;
            let first = std::mem::replace(&mut first_image, false);
            if !first && image_bytes > MAX_IMAGE_BYTES_TOTAL {
                return false;
            }
        }
        text_bytes = text_after;
        kept += 1;
        true
    });
}

fn set_favorite(entries: &mut Vec<ClipEntry>, id: u64, favorite: bool, now_ms: i64) -> Result<(), String> {
    let entry = entries.iter_mut().find(|e| e.id == id).ok_or(GONE)?;
    entry.favorite = favorite;
    // Unstarring counts as fresh use, or a favorite starred months ago would
    // vanish the moment it is unstarred, with no way to star it back.
    if !favorite {
        entry.copied_at = entry.copied_at.max(now_ms);
    }
    // An item that is no longer a favorite counts toward the limits again.
    trim(entries, now_ms);
    Ok(())
}

/// Replaces a text item's text in place; it keeps its position and time. If
/// the new text matches another item, the two become one (still a favorite
/// if either was).
fn edit_text(entries: &mut Vec<ClipEntry>, id: u64, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("An item can't be empty. Delete it instead.".into());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err("That's too long to keep in the history.".into());
    }
    let index = entries.iter().position(|e| e.id == id).ok_or(GONE)?;
    if entries[index].image.is_some() {
        return Err("Only text items can be edited.".into());
    }
    entries[index].text = text;
    let edited = entries[index].clone();
    let favorite = entries.iter().any(|e| e.favorite && e.same_item(&edited));
    entries.retain(|e| e.id == id || !e.same_item(&edited));
    if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
        entry.favorite = favorite;
    }
    Ok(())
}

const GONE: &str = "That item is no longer in the history";

fn temp_path(path: &std::path::Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ClipboardHistory {
    fn load(path: Option<PathBuf>, enabled: bool) -> Self {
        let entries = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<ClipEntry>>(&bytes).ok())
            .unwrap_or_default();
        Self {
            entries: Mutex::new(entries),
            path,
            enabled: AtomicBool::new(enabled),
            target: Mutex::new(None),
            own_window: Mutex::new(None),
        }
    }

    fn save(&self, entries: &[ClipEntry]) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        // An empty history is no file at all, so nothing cleared lingers. A
        // failed write can leave the temporary copy behind, so it goes too.
        if entries.is_empty() {
            return [path.clone(), temp_path(path)]
                .iter()
                .try_for_each(|file| match std::fs::remove_file(file) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
                    _ => Ok(()),
                });
        }
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = temp_path(path);
            std::fs::write(&tmp, serde_json::to_vec(entries)?)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(&tmp, path)
        })();
        result.map_err(|error| error.to_string())
    }

    fn images_dir(&self) -> Option<PathBuf> {
        Some(self.path.as_ref()?.parent()?.join(IMAGES_DIR))
    }

    fn record(&self, text: String, image: Option<PreparedImage>) -> bool {
        let mut entries = self.entries.lock();
        // Checked under the lock, so a copy racing the switch to off cannot
        // land after the clear.
        if !self.enabled.load(Ordering::Relaxed) {
            return false;
        }
        // Files first, so the history never names an image that is not on
        // disk. Under the lock, so a sweep cannot remove them in between.
        let mut image = image;
        if let (Some(image), Some(dir)) = (&mut image, self.images_dir()) {
            match self.store_image(&dir, image) {
                // The budget counts what is on disk, which for a picture
                // already kept is the first encoding, not this one.
                Ok(stored) => image.info.bytes = stored,
                Err(error) => {
                    tracing::warn!("clipboard image not saved: {error}");
                    return false;
                }
            }
        }
        if !push_entry(&mut entries, text, image.map(|i| i.info), now_ms()) {
            return false;
        }
        if let Err(error) = self.save(&entries) {
            tracing::warn!("clipboard history not saved: {error}");
        } else if let Err(error) = self.sweep_images(&entries) {
            tracing::warn!("old clipboard images not removed: {error}");
        }
        true
    }

    /// Writes the PNG and thumbnail unless that picture is already stored,
    /// and returns the stored PNG's size.
    fn store_image(&self, dir: &Path, image: &PreparedImage) -> std::io::Result<u64> {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let hash = &image.info.hash;
        for (path, bytes) in [(image_path(dir, hash), &image.png), (thumb_path(dir, hash), &image.thumb)] {
            if !path.exists() {
                write_private(&path, bytes)?;
            }
        }
        Ok(std::fs::metadata(image_path(dir, hash))?.len())
    }

    /// Deletes every file in the images folder the history no longer names,
    /// leftovers from a crash included, and the folder once it is empty.
    fn sweep_images(&self, entries: &[ClipEntry]) -> Result<(), String> {
        let Some(dir) = self.images_dir() else { return Ok(()) };
        let keep: std::collections::HashSet<String> = entries
            .iter()
            .filter_map(|e| e.image.as_ref())
            .flat_map(|i| [format!("{}.png", i.hash), format!("{}{THUMB_SUFFIX}", i.hash)])
            .collect();
        let listing = match std::fs::read_dir(&dir) {
            Ok(listing) => listing,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        for file in listing.flatten() {
            if !keep.contains(&*file.file_name().to_string_lossy()) {
                std::fs::remove_file(file.path()).map_err(|e| e.to_string())?;
            }
        }
        if keep.is_empty() {
            std::fs::remove_dir(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn snapshot(&self) -> Vec<ClipEntry> {
        self.entries.lock().clone()
    }

    fn entry(&self, id: u64) -> Option<ClipEntry> {
        self.entries.lock().iter().find(|e| e.id == id).cloned()
    }

    /// The stored PNG (or its thumbnail) for an image item.
    fn image_file(&self, id: u64, thumb: bool) -> Option<PathBuf> {
        let image = self.entry(id)?.image?;
        let dir = self.images_dir()?;
        Some(if thumb { thumb_path(&dir, &image.hash) } else { image_path(&dir, &image.hash) })
    }

    /// Removal and clearing report a failed write: the user asked for that
    /// item to be gone, and it would come back on the next launch.
    /// Memory only changes once the disk write lands, so the picker never
    /// shows as gone what will come back on the next launch.
    fn replace(&self, entries: &mut Vec<ClipEntry>, next: Vec<ClipEntry>) -> Result<(), String> {
        self.save(&next)?;
        *entries = next;
        self.sweep_images(entries)
    }

    /// Applies a change to a copy and saves it; memory changes only once
    /// the disk write lands, as with `replace`.
    fn update(&self, change: impl FnOnce(&mut Vec<ClipEntry>) -> Result<(), String>) -> Result<(), String> {
        let mut entries = self.entries.lock();
        let mut next = entries.clone();
        change(&mut next)?;
        self.replace(&mut entries, next)
    }

    fn remove(&self, id: u64) -> Result<(), String> {
        self.update(|entries| {
            entries.retain(|e| e.id != id);
            Ok(())
        })
    }

    fn set_favorite(&self, id: u64, favorite: bool) -> Result<(), String> {
        self.update(|entries| set_favorite(entries, id, favorite, now_ms()))
    }

    /// Drops what has aged past `MAX_AGE_MS` when no copy has come in to do
    /// it. Writes only when something went. Returns whether the history
    /// changed; a failed write leaves it as it was and is retried next time.
    fn expire(&self, now_ms: i64) -> bool {
        let mut entries = self.entries.lock();
        if !entries.iter().any(|e| is_expired(e, now_ms)) {
            return false;
        }
        let mut next = entries.clone();
        next.retain(|e| !is_expired(e, now_ms));
        match self.replace(&mut entries, next) {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!("old clipboard history not removed: {error}");
                // `replace` only fails before memory changes or after it
                // changed; report what memory now holds.
                !entries.iter().any(|e| is_expired(e, now_ms))
            }
        }
    }

    fn edit(&self, id: u64, text: String) -> Result<(), String> {
        self.update(|entries| edit_text(entries, id, text))
    }

    /// Turning history off deletes favorites too: off means nothing kept.
    fn disable_and_clear(&self) -> Result<(), String> {
        let mut entries = self.entries.lock();
        self.enabled.store(false, Ordering::Relaxed);
        self.replace(&mut entries, Vec::new())
    }

    /// Writes a thumbnail rebuilt at today's size, unless history was turned
    /// off or the picture left it while the rebuild ran. Every sweep holds the
    /// history lock, and so does this, so a clear can never land between the
    /// check and the write and leave a thumbnail behind.
    fn store_rebuilt_thumb(&self, hash: &str, thumb: &[u8]) -> std::io::Result<bool> {
        let entries = self.entries.lock();
        let kept = self.enabled.load(Ordering::Relaxed)
            && entries.iter().any(|e| e.image.as_ref().is_some_and(|i| i.hash == hash));
        let Some(dir) = self.images_dir().filter(|_| kept) else {
            return Ok(false);
        };
        write_private(&thumb_path(&dir, hash), thumb)?;
        Ok(true)
    }

    /// Clear all keeps favorites, as ClipBook does.
    fn clear(&self) -> Result<(), String> {
        self.update(|entries| {
            entries.retain(|e| e.favorite);
            Ok(())
        })
    }
}

// ---------- Platform: change counter, privacy markers, paste ----------

#[cfg(target_os = "macos")]
mod platform {
    use super::{ImageRead, PasteTarget, RawImage};
    use tauri::AppHandle;

    extern "C" {
        fn clipy_pasteboard_change_count() -> std::ffi::c_long;
        fn clipy_pasteboard_is_private() -> std::ffi::c_int;
        fn clipy_pasteboard_image_png(len: *mut usize, max_pixels: u64) -> *mut u8;
        fn clipy_free(ptr: *mut std::ffi::c_void);
        fn clipy_pasteboard_write_png(
            bytes: *const u8,
            len: usize,
            text: *const std::ffi::c_char,
        ) -> std::ffi::c_int;
        fn clipy_frontmost_pid() -> std::ffi::c_int;
        fn clipy_activate_pid(pid: std::ffi::c_int) -> std::ffi::c_int;
        fn clipy_post_paste();
        fn clipy_app_is_running(bundle_id: *const std::ffi::c_char) -> std::ffi::c_int;
    }

    pub fn is_running(bundle_id: &std::ffi::CStr) -> bool {
        // SAFETY: a NUL-terminated string the native side only reads.
        unsafe { clipy_app_is_running(bundle_id.as_ptr()) != 0 }
    }

    pub fn change_count() -> i64 {
        // SAFETY: no arguments; the native side owns its autorelease pool.
        unsafe { clipy_pasteboard_change_count() as i64 }
    }

    pub fn is_private() -> Option<bool> {
        // SAFETY: as above.
        Some(unsafe { clipy_pasteboard_is_private() != 0 })
    }

    /// The pasteboard never refuses a read, so a failed text read means there
    /// was no text.
    pub fn has_text() -> bool {
        false
    }

    pub fn read_image(_app: &AppHandle) -> ImageRead {
        let mut len = 0usize;
        // SAFETY: the native side writes `len` and returns a malloc'd buffer
        // of that many bytes, or NULL. It is copied, then freed once.
        unsafe {
            let ptr = clipy_pasteboard_image_png(&mut len, super::MAX_IMAGE_PIXELS);
            if ptr.is_null() {
                return ImageRead::Missing;
            }
            let png = std::slice::from_raw_parts(ptr, len).to_vec();
            clipy_free(ptr.cast());
            ImageRead::Found(RawImage::Png(png))
        }
    }

    pub fn write_image(_app: &AppHandle, png: &[u8], text: &str) -> Result<(), String> {
        // Text with a NUL in it cannot cross as a C string; the image still can.
        let text = std::ffi::CString::new(text).ok().filter(|t| !t.as_bytes().is_empty());
        let text_ptr = text.as_ref().map_or(std::ptr::null(), |t| t.as_ptr());
        // SAFETY: `png` and `text` outlive the call, which copies both.
        let written = unsafe { clipy_pasteboard_write_png(png.as_ptr(), png.len(), text_ptr) };
        if written == 0 {
            return Err("Could not put the image on the clipboard".into());
        }
        Ok(())
    }

    pub fn current_target() -> Option<PasteTarget> {
        // SAFETY: as above.
        let pid = unsafe { clipy_frontmost_pid() };
        (pid > 0 && pid as u32 != std::process::id()).then_some(PasteTarget::Pid(pid))
    }

    pub fn can_paste() -> bool {
        cidre::ax::is_process_trusted()
    }

    pub fn is_frontmost(target: PasteTarget) -> bool {
        let PasteTarget::Pid(pid) = target;
        // SAFETY: no arguments.
        unsafe { clipy_frontmost_pid() == pid }
    }

    pub fn activate(target: PasteTarget) -> bool {
        let PasteTarget::Pid(pid) = target;
        // SAFETY: only an integer crosses the boundary.
        unsafe { clipy_activate_pid(pid) != 0 }
    }

    pub fn post_paste() -> bool {
        // SAFETY: no arguments.
        unsafe { clipy_post_paste() };
        true
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{ImageRead, PasteTarget, RawImage};
    use tauri::AppHandle;
    use windows::core::w;
    use windows::Win32::Foundation::{HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    pub fn change_count() -> i64 {
        // SAFETY: plain Win32 call, no arguments.
        unsafe { GetClipboardSequenceNumber() as i64 }
    }

    /// The formats Windows' own clipboard history honors. Password managers
    /// set them so their secrets are not kept. `None` when the clipboard is
    /// locked and the opt-out value cannot be read yet.
    pub fn is_private() -> Option<bool> {
        // SAFETY: registering and testing formats only reads; the clipboard
        // is closed on every path after it opens, and the global is unlocked.
        unsafe {
            let marked = [
                RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")),
                RegisterClipboardFormatW(w!("Clipboard Viewer Ignore")),
            ]
            .into_iter()
            .any(|format| format != 0 && IsClipboardFormatAvailable(format).is_ok());
            if marked {
                return Some(true);
            }
            // A DWORD 0 here opts the item out of history; its presence alone
            // does not.
            let history = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
            if history == 0 || IsClipboardFormatAvailable(history).is_err() {
                return Some(false);
            }
            OpenClipboard(HWND::default()).ok()?;
            let opted_out = GetClipboardData(history).ok().and_then(|handle| {
                let global = HGLOBAL(handle.0);
                let value = GlobalLock(global) as *const u32;
                if value.is_null() {
                    return None;
                }
                let flag = value.read_unaligned();
                let _ = GlobalUnlock(global);
                Some(flag == 0)
            });
            let _ = CloseClipboard();
            opted_out
        }
    }

    /// Whether the clipboard holds text, asked without opening it. Windows
    /// also offers `CF_UNICODETEXT` for an app that put up `CF_TEXT`.
    pub fn has_text() -> bool {
        // SAFETY: a format query only reads.
        unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_ok() }
    }

    /// The "PNG" format when an app put one up (alpha intact), else
    /// `CF_DIB`, which Windows also produces on request from `CF_BITMAP` and
    /// `CF_DIBV5`, so every bitmap an app copies arrives here. A `CF_HDROP`
    /// beside the bitmap does not make it a file copy: Explorer puts up no
    /// bitmap for copied files, so files still read as `Missing`, while apps
    /// that copy an image as both pixels and a file (Photos, Firefox's
    /// image-as-file) are kept. macOS needs the opposite check because
    /// Finder adds a file's icon as TIFF. The header's size is checked on
    /// the locked memory, before anything is copied out of it. An image too
    /// large or unreadable is `Missing`, so text copied with it is kept;
    /// only a clipboard that would not open is `Busy`.
    pub fn read_image(_app: &AppHandle) -> ImageRead {
        // SAFETY: format queries only read. The clipboard is closed on every
        // path after it opens, the global is unlocked after every successful
        // lock, and the slice never outlives the lock.
        unsafe {
            let png_format = RegisterClipboardFormatW(w!("PNG"));
            let png = png_format != 0 && IsClipboardFormatAvailable(png_format).is_ok();
            let format = if png {
                png_format
            } else if IsClipboardFormatAvailable(CF_DIB.0 as u32).is_ok() {
                CF_DIB.0 as u32
            } else {
                return ImageRead::Missing;
            };
            if OpenClipboard(HWND::default()).is_err() {
                return ImageRead::Busy;
            }
            let bytes = GetClipboardData(format).ok().and_then(|handle| {
                let global = HGLOBAL(handle.0);
                let size = GlobalSize(global);
                let data = GlobalLock(global) as *const u8;
                if data.is_null() {
                    return None;
                }
                let raw = std::slice::from_raw_parts(data, size);
                let bytes = super::header_fits(raw, png).then(|| raw.to_vec());
                let _ = GlobalUnlock(global);
                bytes
            });
            let _ = CloseClipboard();
            match bytes {
                Some(bytes) if png => ImageRead::Found(RawImage::Png(bytes)),
                Some(bytes) => ImageRead::Found(RawImage::Dib(bytes)),
                None => ImageRead::Missing,
            }
        }
    }

    pub fn write_image(_app: &AppHandle, png: &[u8], text: &str) -> Result<(), String> {
        crate::screenshot_win::copy_png_and_text_to_clipboard(png, text)
    }

    pub fn current_target() -> Option<PasteTarget> {
        // SAFETY: reads the foreground window and its owning process id.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            (pid != std::process::id()).then_some(PasteTarget::Hwnd(hwnd.0 as isize))
        }
    }

    pub fn can_paste() -> bool {
        true
    }

    pub fn is_frontmost(target: PasteTarget) -> bool {
        let PasteTarget::Hwnd(raw) = target;
        // SAFETY: reads the foreground window handle only.
        unsafe { GetForegroundWindow().0 as isize == raw }
    }

    pub fn activate(target: PasteTarget) -> bool {
        let PasteTarget::Hwnd(raw) = target;
        // SAFETY: a stale handle makes SetForegroundWindow fail, nothing worse.
        unsafe { SetForegroundWindow(HWND(raw as *mut _)).as_bool() }
    }

    fn key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    /// False when Windows blocked the input, e.g. the target runs elevated.
    pub fn post_paste() -> bool {
        let inputs = [
            key(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
            key(VK_V, KEYBD_EVENT_FLAGS(0)),
            key(VK_V, KEYEVENTF_KEYUP),
            key(VK_CONTROL, KEYEVENTF_KEYUP),
        ];
        // SAFETY: the array outlives the call and the size is the struct's.
        unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) as usize == inputs.len() }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{ImageRead, PasteTarget};
    use tauri::AppHandle;
    pub fn change_count() -> i64 {
        0
    }
    pub fn is_private() -> Option<bool> {
        Some(false)
    }
    pub fn has_text() -> bool {
        false
    }
    pub fn read_image(_: &AppHandle) -> ImageRead {
        ImageRead::Missing
    }
    pub fn write_image(_: &AppHandle, _: &[u8], _: &str) -> Result<(), String> {
        Err("Images are not supported here".into())
    }
    pub fn current_target() -> Option<PasteTarget> {
        None
    }
    pub fn can_paste() -> bool {
        false
    }
    pub fn is_frontmost(_: PasteTarget) -> bool {
        false
    }
    pub fn activate(_: PasteTarget) -> bool {
        false
    }
    pub fn post_paste() -> bool {
        false
    }
}

// ---------- Setup and the watcher ----------

pub fn is_enabled(app: &AppHandle) -> bool {
    app.store(crate::commands::SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(ENABLED_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

pub fn init(app: &AppHandle) {
    let path = app.path().app_data_dir().ok().map(|dir| dir.join(FILE_NAME));
    let history = ClipboardHistory::load(path, is_enabled(app));
    history.expire(now_ms());
    app.manage(history);

    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("clipboard-history".into())
        .spawn(move || watch(app));
    if let Err(error) = spawned {
        tracing::warn!("clipboard history watcher did not start: {error}");
    }
}

/// Copied files (and anything else with neither text nor an image) fail
/// every read, so the retries stop after a few and the item is skipped.
fn retry_later(attempts: &mut u32, last: &mut i64, count: i64) {
    *attempts += 1;
    if *attempts >= READ_ATTEMPTS {
        *attempts = 0;
        *last = count;
    }
}

/// Text and image from one clipboard item. As in ClipBook, an image makes it
/// an image item, with the text kept beside it; `None` when it should be read
/// again: nothing usable, or text or an image the clipboard would not hand
/// over yet.
fn read_copied(app: &AppHandle) -> Option<(String, Option<RawImage>)> {
    let text = match app.clipboard().read_text() {
        Ok(text) => Some(text),
        // Text is there but the clipboard would not hand it over yet.
        Err(_) if platform::has_text() => return None,
        Err(_) => None,
    };
    match platform::read_image(app) {
        ImageRead::Found(image) => Some((text.unwrap_or_default(), Some(image))),
        ImageRead::Busy => None,
        ImageRead::Missing => text.map(|text| (text, None)),
    }
}

/// Polls the OS change counter, which costs nothing, and reads the clipboard
/// only when it moves. Neither macOS nor Windows offers a change notification
/// that works for a background app without a window of its own.
fn watch(app: AppHandle) {
    let mut last = platform::change_count();
    // Retries belong to one clipboard item; a new copy gets a fresh budget.
    let mut attempts = 0;
    let mut retrying = last;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let history = app.state::<ClipboardHistory>();
        let count = platform::change_count();
        if count == last {
            continue;
        }
        if count != retrying {
            retrying = count;
            attempts = 0;
        }
        // Nothing is kept while the picker cannot be opened (no key, or
        // another app owns it): it would be history the user cannot reach.
        if !history.enabled.load(Ordering::Relaxed)
            || !crate::recorder_actions::is_live(&app, SHORTCUT_ACTION)
        {
            last = count;
            continue;
        }
        match platform::is_private() {
            Some(false) => {}
            Some(true) => {
                last = count;
                continue;
            }
            None => {
                retry_later(&mut attempts, &mut last, count);
                continue;
            }
        }
        let Some((text, raw_image)) = read_copied(&app) else {
            retry_later(&mut attempts, &mut last, count);
            continue;
        };
        attempts = 0;
        // The privacy check ran before the read. If the clipboard moved in
        // between (a password manager copying right then), this may be the
        // new item, so take it again on the next tick instead.
        if platform::change_count() != count {
            continue;
        }
        last = count;
        // Unknown counts as private here: the item is already read and a
        // retry would not see a different one.
        if platform::is_private() != Some(false) {
            continue;
        }
        // Decoding, hashing and thumbnailing happen only for what is kept.
        let image = match raw_image {
            Some(raw) => match prepare_image(raw) {
                Some(image) => Some(image),
                // Too large or undecodable: the text alone, if there was any.
                None if !text.trim().is_empty() => None,
                None => continue,
            },
            None => None,
        };
        if history.record(text, image) {
            let _ = app.emit_to(LABEL, EVENT_CHANGED, ());
        }
    }
}

// ---------- The picker window ----------

fn create_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#clipboard".into()))
        .title(crate::i18n::t("windowTitles.clipboard"))
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(!cfg!(target_os = "windows"))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .accept_first_mouse(true)
        .visible(false)
        .build()
        .map_err(|e| format!("open clipboard history: {e}"))?;

    // Like Spotlight: clicking anywhere else dismisses it.
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = handle.hide();
        }
    });

    #[cfg(target_os = "macos")]
    {
        let _ = window.set_visible_on_all_workspaces(true);
        let sharing_window = window.clone();
        crate::commands::run_on_main_thread_result(app, "clipboard window sharing", move |_| {
            if let Ok(ns_window) = sharing_window.ns_window() {
                // SAFETY: the live Tauri window owns this NSWindow, and AppKit
                // is called on the main thread.
                unsafe { crate::commands::set_window_sharing_none(ns_window) };
            }
            Ok(())
        })?;
    }
    // Copied text can be anything, passwords included: never in a recording.
    #[cfg(target_os = "windows")]
    crate::commands::exclude_window_from_capture(&window);
    Ok(window)
}

/// Centers the picker on the display under the pointer, where the user is
/// looking, rather than always on the primary one.
fn place(app: &AppHandle, window: &tauri::WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };
    // Physical pixels throughout: a logical position would be converted with
    // the window's current scale, which on mixed-DPI setups belongs to the
    // display it is leaving.
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let (width, height) = picker_size(work.size.width as f64 / scale, work.size.height as f64 / scale);
    let (width, height) = (width * scale, height * scale);
    let x = work.position.x as f64 + (work.size.width as f64 - width) / 2.0;
    let y = work.position.y as f64 + (work.size.height as f64 - height) / 3.0;
    let position = tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32);
    // Move first, then size: a physical size is converted with the scale of
    // the display the window is on (macOS), and moving across displays
    // rescales it (Windows), so sizing before the move gets the size wrong on
    // mixed-DPI setups. Placed again after, in case the resize moved the top.
    let _ = window.set_position(position);
    let _ = window.set_size(tauri::PhysicalSize::new(width.round() as u32, height.round() as u32));
    let _ = window.set_position(position);
}

/// The picker's logical size on a work area of this logical size: about two
/// thirds of the width, so copied images show as large cards and the preview
/// beside them is readable, like Spotlight's file search. Small displays get
/// most of the screen, very large ones a fixed ceiling.
fn picker_size(work_width: f64, work_height: f64) -> (f64, f64) {
    let width = (work_width * 0.64).clamp(760.0_f64.min(work_width * 0.95), 1500.0);
    let height = (work_height * 0.72).clamp(520.0_f64.min(work_height * 0.9), 940.0);
    (width.round(), height.round())
}

pub async fn toggle_picker(app: AppHandle) -> Result<(), String> {
    // Two quick presses would otherwise both try to create the window.
    static OPENING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = OPENING.lock().await;
    if !app.state::<ClipboardHistory>().enabled.load(Ordering::Relaxed) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) {
            return_focus(&app);
            return Ok(());
        }
    }
    // Read before Clipy takes focus, or the frontmost app is Clipy itself.
    let target = platform::current_target();
    *app.state::<ClipboardHistory>().own_window.lock() = if target.is_none() {
        app.webview_windows()
            .into_iter()
            .find(|(label, window)| label != LABEL && window.is_focused().unwrap_or(false))
            .map(|(label, _)| label)
    } else {
        None
    };
    *app.state::<ClipboardHistory>().target.lock() = target;
    let window = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => create_window(&app)?,
    };
    if app.state::<ClipboardHistory>().expire(now_ms()) {
        let _ = app.emit_to(LABEL, EVENT_CHANGED, ());
    }
    place(&app, &window);
    // Again on every open, now that it sits on its display: whether exclusion
    // draws it black depends on the session and that display, both of which
    // can change while the window is reused.
    #[cfg(target_os = "windows")]
    crate::commands::exclude_window_from_capture(&window);
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().ok();
    let _ = app.emit_to(LABEL, EVENT_OPENED, ());
    crate::whats_new::mark_tried(&app, "clipboard");
    Ok(())
}

// ---------- Commands ----------

/// Async so a large history is cloned off the main thread.
#[tauri::command]
pub async fn get_clipboard_history(app: AppHandle) -> Vec<ClipEntry> {
    app.state::<ClipboardHistory>().snapshot()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteOutcome {
    /// False when the item is only on the clipboard: no Accessibility
    /// permission, or no app to return to. A notification says so.
    pasted: bool,
}

/// Copies the entry, hands focus back to the previous app and presses
/// ⌘V / Ctrl+V there. Async so the short waits never run on the main thread.
#[tauri::command]
pub async fn paste_clipboard_entry(app: AppHandle, id: u64) -> Result<PasteOutcome, String> {
    let history = app.state::<ClipboardHistory>();
    write_entry(&app, id).await?;
    if !platform::can_paste() {
        // Back in the user's app first, so the ⌘V they press lands there and
        // not in the picker's search field.
        return_focus(&app);
        notify(
            &app,
            "Copied. Press ⌘V to paste. Turn on Clipy in System Settings → Privacy & Security → Accessibility to paste automatically.",
        );
        return Ok(PasteOutcome { pasted: false });
    }
    if history.own_window.lock().is_some() {
        if !return_focus(&app) {
            notify_copied_only(&app);
            return Ok(PasteOutcome { pasted: false });
        }
        // Clipy is already frontmost; give the field a beat to take focus.
        tokio::time::sleep(Duration::from_millis(120)).await;
        let pasted = platform::post_paste();
        if !pasted {
            notify_copied_only(&app);
        }
        return Ok(PasteOutcome { pasted });
    }
    let target = *history.target.lock();
    if !return_focus(&app) {
        notify_copied_only(&app);
        return Ok(PasteOutcome { pasted: false });
    }
    let Some(target) = target else {
        notify_copied_only(&app);
        return Ok(PasteOutcome { pasted: false });
    };
    // Activation is asynchronous; a keystroke sent before the other app is
    // frontmost lands nowhere.
    for _ in 0..50 {
        if platform::is_frontmost(target) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !platform::is_frontmost(target) {
        notify_copied_only(&app);
        return Ok(PasteOutcome { pasted: false });
    }
    // A beat for the app to make its text field key again.
    tokio::time::sleep(Duration::from_millis(60)).await;
    let pasted = platform::post_paste();
    if !pasted {
        notify_copied_only(&app);
    }
    Ok(PasteOutcome { pasted })
}

/// Puts an item back on the system clipboard: its image and text, or its text.
async fn write_entry(app: &AppHandle, id: u64) -> Result<(), String> {
    let history = app.state::<ClipboardHistory>();
    let entry = history.entry(id).ok_or(GONE)?;
    if entry.image.is_some() {
        let path = history.image_file(id, false).ok_or(GONE)?;
        let png = tokio::fs::read(&path)
            .await
            .map_err(|e| format!("That image could not be read: {e}"))?;
        platform::write_image(app, &png, &entry.text)
    } else {
        app.clipboard().write_text(entry.text).map_err(|e| e.to_string())
    }
}

/// ClipBook's Copy button: the item goes on the clipboard without being
/// pasted, and the user is back in their app to paste it wherever they like.
#[tauri::command]
pub async fn copy_clipboard_entry(app: AppHandle, id: u64) -> Result<(), String> {
    write_entry(&app, id).await?;
    return_focus(&app);
    Ok(())
}

#[tauri::command]
pub fn set_clipboard_entry_favorite(app: AppHandle, id: u64, favorite: bool) -> Result<(), String> {
    app.state::<ClipboardHistory>()
        .set_favorite(id, favorite)
        .map_err(|e| if e == GONE { e } else { format!("Could not update the saved history: {e}") })
}

#[tauri::command]
pub fn edit_clipboard_entry(app: AppHandle, id: u64, text: String) -> Result<(), String> {
    app.state::<ClipboardHistory>().edit(id, text)
}

/// At most this many thumbnails are rebuilt at once. A rebuild decodes the
/// whole picture (up to 40 MP), and the first open after an update asks for
/// every card's thumbnail together.
static THUMB_REBUILDS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Pictures whose rebuild failed this run (a PNG that no longer decodes).
/// They keep their old thumbnail instead of being decoded again on every
/// open; the next launch tries once more.
static FAILED_THUMB_REBUILDS: Mutex<Vec<String>> = parking_lot::const_mutex(Vec::new());

/// The image item, its thumbnail path and its full PNG path.
fn image_paths(app: &AppHandle, id: u64) -> Result<(ClipImage, PathBuf, PathBuf), String> {
    let history = app.state::<ClipboardHistory>();
    let image = history.entry(id).and_then(|e| e.image).ok_or(GONE)?;
    let thumb = history.image_file(id, true).ok_or(GONE)?;
    let full = history.image_file(id, false).ok_or(GONE)?;
    Ok((image, thumb, full))
}

/// The grid card preview for an image item, as raw PNG bytes. A thumbnail
/// stored when they were smaller is rebuilt from the full picture once.
#[tauri::command]
pub async fn clipboard_image_thumbnail(app: AppHandle, id: u64) -> Result<tauri::ipc::Response, String> {
    let (image, path, _) = image_paths(&app, id)?;
    // A missing thumbnail is rebuilt like an outdated one.
    let thumb = match tokio::fs::read(&path).await {
        Ok(thumb) if !thumb_is_stale(&thumb, &image) => return Ok(tauri::ipc::Response::new(thumb)),
        Ok(thumb) => Some(thumb),
        Err(_) => None,
    };
    if FAILED_THUMB_REBUILDS.lock().contains(&image.hash) {
        return thumb
            .map(tauri::ipc::Response::new)
            .ok_or_else(|| "read clipboard image: no thumbnail".to_string());
    }
    let _permit = THUMB_REBUILDS.acquire().await.map_err(|e| e.to_string())?;
    // The wait can be long: the picture may have left the history, or the
    // preview pane's request for the same picture may have rebuilt it.
    let (image, path, full) = image_paths(&app, id)?;
    let thumb = match tokio::fs::read(&path).await {
        Ok(fresh) if !thumb_is_stale(&fresh, &image) => return Ok(tauri::ipc::Response::new(fresh)),
        Ok(fresh) => Some(fresh),
        Err(_) => thumb,
    };
    let handle = app.clone();
    let hash = image.hash.clone();
    let rebuilt = tokio::task::spawn_blocking(move || {
        let rebuilt = make_thumb(&decode_png(&std::fs::read(&full).ok()?)?)?;
        let history = handle.state::<ClipboardHistory>();
        if let Err(error) = history.store_rebuilt_thumb(&image.hash, &rebuilt) {
            tracing::warn!("clipboard thumbnail not replaced: {error}");
        }
        Some(rebuilt)
    })
    .await
    .ok()
    .flatten();
    if rebuilt.is_none() {
        FAILED_THUMB_REBUILDS.lock().push(hash);
    }
    // The old, smaller thumbnail still beats an empty card.
    rebuilt
        .or(thumb)
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| "read clipboard image: no thumbnail".to_string())
}

/// The full picture for the preview pane, as the PNG it was stored as.
#[tauri::command]
pub async fn clipboard_image(app: AppHandle, id: u64) -> Result<tauri::ipc::Response, String> {
    let path = app.state::<ClipboardHistory>().image_file(id, false).ok_or(GONE)?;
    tokio::fs::read(&path)
        .await
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("read clipboard image: {e}"))
}

#[tauri::command]
pub fn delete_clipboard_entry(app: AppHandle, id: u64) -> Result<(), String> {
    app.state::<ClipboardHistory>()
        .remove(id)
        .map_err(|e| format!("Could not update the saved history: {e}"))
}

#[tauri::command]
pub fn clear_clipboard_history(app: AppHandle) -> Result<(), String> {
    app.state::<ClipboardHistory>()
        .clear()
        .map_err(|e| format!("Could not delete the saved history: {e}"))
}

/// The picker is already gone when an automatic paste fails (no app to go
/// back to, an elevated target on Windows), so say it with a notification.
fn notify_copied_only(app: &AppHandle) {
    let key = if cfg!(target_os = "macos") { "⌘V" } else { "Ctrl+V" };
    notify(
        app,
        &crate::i18n::t_with("notifications.clipboardCopiedOnly", &[("key", key)]),
    );
}

fn notify(app: &AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(crate::i18n::t("windowTitles.clipboard")).body(body).show();
}

/// Hands focus back to the app the picker opened over, then hides it.
/// Activate first: Windows only lets the foreground process give the
/// foreground away, and after the hide that is no longer Clipy.
fn return_focus(app: &AppHandle) -> bool {
    let history = app.state::<ClipboardHistory>();
    let target = history.target.lock().take();
    let own = history.own_window.lock().take();
    let activated = target.is_some_and(platform::activate);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    match own.and_then(|label| app.get_webview_window(&label)) {
        Some(window) => window.set_focus().is_ok(),
        None => activated,
    }
}

/// The app the user is typing in now, so something can be pasted into it
/// later (Talk to your agent reads this when the take starts).
pub(crate) fn frontmost_target() -> Option<PasteTarget> {
    platform::current_target()
}

/// Puts `text` on the clipboard and presses ⌘V / Ctrl+V in `target`, or in
/// whatever is frontmost when there is none. False when the text is only on
/// the clipboard: no Accessibility permission, or the app could not be
/// brought back.
pub(crate) async fn paste_text_into(app: &AppHandle, text: &str, target: Option<PasteTarget>) -> bool {
    if let Err(err) = app.clipboard().write_text(text.to_string()) {
        tracing::warn!("paste text could not reach the clipboard: {err:#}");
        return false;
    }
    if !platform::can_paste() {
        return false;
    }
    if let Some(target) = target {
        if !platform::is_frontmost(target) {
            if !platform::activate(target) {
                return false;
            }
            // Activation is asynchronous; a keystroke sent before the other
            // app is frontmost lands nowhere.
            for _ in 0..50 {
                if platform::is_frontmost(target) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            if !platform::is_frontmost(target) {
                return false;
            }
        }
    }
    // A beat for the app to make its text field key again.
    tokio::time::sleep(Duration::from_millis(60)).await;
    platform::post_paste()
}

/// Esc: close without pasting, back in the app the user was typing in.
#[tauri::command]
pub fn hide_clipboard_history(app: AppHandle) {
    return_focus(&app);
}

/// Clipboard managers that ship on ⇧⌘V. When two apps register the same
/// global key only one of them receives it, and macOS reports success to
/// both, so Settings names the other app rather than promise the key works.
#[cfg(target_os = "macos")]
const SAME_KEY_APPS: [(&std::ffi::CStr, &str); 4] = [
    (c"com.ikryanov.clipbook", "ClipBook"),
    (c"com.wiheads.paste", "Paste"),
    (c"com.wiheads.paste-setapp", "Paste"),
    (c"com.generalarcade.flycut", "Flycut"),
];

/// The running app that also opens on the clipboard key, if any. Only the
/// default key is checked: those apps' own key choices are not readable.
#[tauri::command]
pub fn get_clipboard_key_clash(app: AppHandle) -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        let key = crate::recorder_actions::hotkey_for(&app, SHORTCUT_ACTION)?;
        let shared = crate::commands::parse_hotkey(&key)?;
        if crate::commands::parse_hotkey("Meta+Shift+KeyV") != Some(shared) {
            return None;
        }
        SAME_KEY_APPS
            .iter()
            .find(|(bundle_id, _)| platform::is_running(bundle_id))
            .map(|(_, name)| *name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

#[tauri::command]
pub fn get_clipboard_history_enabled(app: AppHandle) -> bool {
    app.state::<ClipboardHistory>().enabled.load(Ordering::Relaxed)
}

/// Turning it off also clears what was kept and releases the shortcut, so
/// "off" means nothing is watched, stored, or bound.
#[tauri::command]
pub fn set_clipboard_history_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let store = app
        .store(crate::commands::SETTINGS_STORE)
        .map_err(|e| e.to_string())?;
    let history = app.state::<ClipboardHistory>();
    // `set` changes the in-memory store before `save` writes it, so a failed
    // write puts the previous value back.
    let previous = store.get(ENABLED_KEY);
    let persist = |value: bool| -> Result<(), String> {
        store.set(ENABLED_KEY, serde_json::json!(value));
        store.save().map_err(|error| {
            match &previous {
                Some(old) => store.set(ENABLED_KEY, old.clone()),
                None => {
                    store.delete(ENABLED_KEY);
                }
            }
            error.to_string()
        })
    };
    if enabled {
        if crate::recorder_actions::hotkey_for(&app, SHORTCUT_ACTION).is_none() {
            return Err("Set a key for Clipboard under Shortcuts first, then turn this on.".into());
        }
        // Key first: if it cannot be taken, nothing is switched on.
        crate::recorder_actions::register_action(&app, SHORTCUT_ACTION)?;
        if let Err(error) = persist(true) {
            crate::recorder_actions::unregister_action(&app, SHORTCUT_ACTION);
            return Err(error);
        }
        history.enabled.store(true, Ordering::Relaxed);
    } else {
        persist(false)?;
        crate::recorder_actions::unregister_action(&app, SHORTCUT_ACTION);
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.close();
        }
        history.disable_and_clear().map_err(|e| {
            format!("Clipboard history is off, but its saved file could not be deleted: {e}")
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(entries: &[ClipEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.text.as_str()).collect()
    }

    #[test]
    fn newest_copy_goes_first() {
        let mut entries = Vec::new();
        assert!(push_entry(&mut entries, "one".into(), None, 1));
        assert!(push_entry(&mut entries, "two".into(), None, 2));
        assert_eq!(texts(&entries), ["two", "one"]);
    }

    #[test]
    fn copying_again_moves_the_item_up_without_a_duplicate() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "one".into(), None, 1);
        push_entry(&mut entries, "two".into(), None, 2);
        assert!(push_entry(&mut entries, "one".into(), None, 3));
        assert_eq!(texts(&entries), ["one", "two"]);
        assert_eq!(entries[0].copied_at, 3);
        // Ids stay unique, so the picker never confuses two rows.
        assert_ne!(entries[0].id, entries[1].id);
    }

    #[test]
    fn copying_the_top_item_again_only_refreshes_its_time() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "one".into(), None, 1);
        // Fresh use: the 90 days count from the latest copy.
        assert!(push_entry(&mut entries, "one".into(), None, 2));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].copied_at, 2);
        // Nothing newer to record (same instant, or a clock that went back).
        assert!(!push_entry(&mut entries, "one".into(), None, 2));
        assert!(!push_entry(&mut entries, "one".into(), None, 1));
        assert_eq!(entries[0].copied_at, 2);
    }

    #[test]
    fn a_recopied_item_does_not_expire_from_its_first_copy() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "keep".into(), None, 0);
        push_entry(&mut entries, "keep".into(), None, MAX_AGE_MS - 1);
        push_entry(&mut entries, "other".into(), None, MAX_AGE_MS + 1);
        assert_eq!(ids_of(&entries), ["other", "keep"]);
    }

    #[test]
    fn blank_and_oversized_copies_are_skipped() {
        let mut entries = Vec::new();
        assert!(!push_entry(&mut entries, "  \n\t".into(), None, 1));
        assert!(!push_entry(&mut entries, "x".repeat(MAX_TEXT_BYTES + 1), None, 1));
        assert!(entries.is_empty());
    }

    #[test]
    fn history_is_capped() {
        let mut entries = Vec::new();
        for i in 0..(MAX_ENTRIES + 10) {
            push_entry(&mut entries, format!("item {i}"), None, i as i64);
        }
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].text, format!("item {}", MAX_ENTRIES + 9));
    }

    #[test]
    fn unstarring_an_old_favorite_keeps_it() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "starred long ago".into(), None, 0);
        let id = entries[0].id;
        set_favorite(&mut entries, id, true, 0).unwrap();
        let later = 5 * MAX_AGE_MS;
        set_favorite(&mut entries, id, false, later).unwrap();
        assert_eq!(ids_of(&entries), ["starred long ago"]);
        assert_eq!(entries[0].copied_at, later);
        // And it can be starred again.
        set_favorite(&mut entries, id, true, later).unwrap();
    }

    #[test]
    fn a_corrupt_copy_time_does_not_panic() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "a".into(), None, 1);
        entries[0].copied_at = i64::MIN;
        push_entry(&mut entries, "b".into(), None, i64::MAX);
        assert_eq!(ids_of(&entries), ["b"]);
    }

    #[test]
    fn text_past_the_budget_goes_oldest_first() {
        let mut entries = Vec::new();
        let big = MAX_TEXT_BYTES; // 50 KB each
        let fits = MAX_TEXT_BYTES_TOTAL / big;
        for i in 0..fits + 3 {
            push_entry(&mut entries, format!("{i:05}{}", "x".repeat(big - 5)), None, i as i64);
        }
        assert_eq!(entries.len(), fits);
        assert!(entries[0].text.starts_with(&format!("{:05}", fits + 2)));
        assert!(entries.iter().map(|e| e.text.len()).sum::<usize>() <= MAX_TEXT_BYTES_TOTAL);
        // Short copies after it are not held back by the big ones.
        push_entry(&mut entries, "short".into(), None, 10_000);
        assert_eq!(entries[0].text, "short");
    }

    #[test]
    fn a_full_text_budget_keeps_older_images_and_text_that_fits() {
        let mut entries = Vec::new();
        push_entry(&mut entries, String::new(), Some(image_info("old", 100)), 0);
        push_entry(&mut entries, "small".into(), None, 1);
        let fits = MAX_TEXT_BYTES_TOTAL / MAX_TEXT_BYTES;
        for i in 0..fits + 1 {
            push_entry(&mut entries, format!("{i:05}{}", "x".repeat(MAX_TEXT_BYTES - 5)), None, 2 + i as i64);
        }
        // One big text is over the budget and goes; the image (no text) stays,
        // and so does the small text, which still fits.
        assert_eq!(entries.len(), fits + 2);
        assert!(entries.iter().any(|e| e.image.as_ref().is_some_and(|i| i.hash == "old")));
        assert!(entries.iter().any(|e| e.text == "small"));
        assert!(entries.iter().map(|e| e.text.len()).sum::<usize>() <= MAX_TEXT_BYTES_TOTAL);
    }

    #[test]
    fn items_older_than_the_age_limit_go_but_favorites_stay() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "old favorite".into(), None, 0);
        let favorite = entries[0].id;
        set_favorite(&mut entries, favorite, true, 0).unwrap();
        push_entry(&mut entries, "old".into(), None, 1);
        push_entry(&mut entries, "edge".into(), None, 2);
        // Exactly at the limit is kept; one millisecond past it is not.
        push_entry(&mut entries, "new".into(), None, 2 + MAX_AGE_MS);
        assert_eq!(ids_of(&entries), ["new", "edge", "old favorite"]);
    }

    #[test]
    fn expiry_without_a_copy_removes_old_items_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let history = ClipboardHistory::load(Some(path.clone()), true);
        history.record("recent".into(), None);
        {
            let mut entries = history.entries.lock();
            let mut stale = entries[0].clone();
            stale.id = 99;
            stale.text = "stale".into();
            stale.copied_at = now_ms() - MAX_AGE_MS - 1;
            entries.push(stale);
        }
        assert!(history.expire(now_ms()));
        assert!(!history.expire(now_ms()));
        let reloaded = ClipboardHistory::load(Some(path), true);
        assert_eq!(ids_of(&reloaded.snapshot()), ["recent"]);
    }

    #[test]
    fn a_rebuilt_thumbnail_is_not_written_once_its_picture_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let history = ClipboardHistory::load(Some(dir.path().join(FILE_NAME)), true);
        let png = encode_png(&picture(5, 800, 600)).unwrap();
        history.record(String::new(), prepare_image(RawImage::Png(png)));
        let hash = history.snapshot()[0].image.as_ref().unwrap().hash.clone();
        let images = history.images_dir().unwrap();
        let thumb = thumb_path(&images, &hash);
        let rebuilt = make_thumb(&picture(5, 800, 600)).unwrap();
        assert!(history.store_rebuilt_thumb(&hash, &rebuilt).unwrap());
        assert_eq!(std::fs::read(&thumb).unwrap(), rebuilt);
        // Deleted while the rebuild ran: nothing comes back.
        history.remove(history.snapshot()[0].id).unwrap();
        assert!(!thumb.exists());
        assert!(!history.store_rebuilt_thumb(&hash, &rebuilt).unwrap());
        assert!(!thumb.exists());
        // Turned off while it ran: the same.
        let png = encode_png(&picture(6, 800, 600)).unwrap();
        history.record(String::new(), prepare_image(RawImage::Png(png)));
        let hash = history.snapshot()[0].image.as_ref().unwrap().hash.clone();
        history.disable_and_clear().unwrap();
        assert!(!history.store_rebuilt_thumb(&hash, &rebuilt).unwrap());
        assert!(!thumb_path(&images, &hash).exists());
    }

    #[test]
    fn history_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let history = ClipboardHistory::load(Some(path.clone()), true);
        history.record("kept".into(), None);
        let reloaded = ClipboardHistory::load(Some(path), true);
        assert_eq!(texts(&reloaded.snapshot()), ["kept"]);
        // A failed write leaves the entries in place.
        let blocked = ClipboardHistory::load(Some(dir.path().join("missing").join("x").join(FILE_NAME)), true);
        blocked.entries.lock().push(ClipEntry { id: 1, text: "kept".into(), image: None, favorite: false, copied_at: 0 });
        std::fs::write(dir.path().join("missing"), b"not a directory").unwrap();
        assert!(blocked.remove(1).is_err());
        assert_eq!(texts(&blocked.snapshot()), ["kept"]);
        reloaded.clear().unwrap();
        assert!(reloaded.snapshot().is_empty());
        // Cleared means the file is gone, not an empty list left on disk.
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    fn picture(seed: u8, width: u32, height: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(width, height, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
    }

    fn png_of(pixels: image::RgbaImage) -> RawImage {
        RawImage::Png(encode_png(&pixels).unwrap())
    }

    /// A 32-bit BI_RGB `CF_DIB`, bottom-up, as Windows hands it over.
    fn dib_of(pixels: &image::RgbaImage) -> Vec<u8> {
        let (width, height) = pixels.dimensions();
        let mut dib = Vec::new();
        for value in [40u32, width, height] {
            dib.extend_from_slice(&value.to_le_bytes());
        }
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&32u16.to_le_bytes());
        dib.extend_from_slice(&[0u8; 24]);
        for y in (0..height).rev() {
            for x in 0..width {
                let [r, g, b, _] = pixels.get_pixel(x, y).0;
                dib.extend_from_slice(&[b, g, r, 0]);
            }
        }
        dib
    }

    fn image_info(hash: &str, bytes: u64) -> ClipImage {
        ClipImage { hash: hash.into(), width: 1, height: 1, bytes }
    }

    #[test]
    fn copies_of_the_same_picture_are_one_item() {
        let one = prepare_image(png_of(picture(1, 30, 20))).unwrap();
        let again = prepare_image(png_of(picture(1, 30, 20))).unwrap();
        let other = prepare_image(png_of(picture(2, 30, 20))).unwrap();
        assert_eq!(one.info.hash, again.info.hash);
        assert_ne!(one.info.hash, other.info.hash);
        assert_eq!((one.info.width, one.info.height), (30, 20));
        assert_eq!(one.info.bytes, one.png.len() as u64);

        let mut entries = Vec::new();
        assert!(push_entry(&mut entries, String::new(), Some(one.info.clone()), 1));
        assert!(push_entry(&mut entries, "text".into(), None, 2));
        // The picture copied again moves up, even with different text beside it.
        assert!(push_entry(&mut entries, "caption".into(), Some(again.info), 3));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].image.as_ref().unwrap().hash, one.info.hash);
        assert_eq!(entries[0].text, "caption");
        // An image item and a text item never match each other.
        assert!(push_entry(&mut entries, "caption".into(), None, 4));
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn png_from_the_clipboard_is_kept_byte_for_byte() {
        let png = encode_png(&picture(3, 800, 600)).unwrap();
        let prepared = prepare_image(RawImage::Png(png.clone())).unwrap();
        assert_eq!(prepared.png, png);
        // Same pixels by either route, so a paste read back is the same item.
        let from_dib = prepare_image(RawImage::Dib(dib_of(&picture(3, 800, 600)))).unwrap();
        assert_eq!(prepared.info.hash, from_dib.info.hash);
        assert_eq!(decode_png(&from_dib.png).unwrap(), picture(3, 800, 600));
        let thumb = decode_png(&prepared.thumb).unwrap();
        assert!(thumb.width() <= THUMB_SIZE && thumb.height() <= THUMB_SIZE);
        assert_eq!(thumb.width(), THUMB_SIZE);
    }

    #[test]
    fn thumbnails_made_for_the_old_row_size_are_rebuilt() {
        let big = ClipImage { hash: "h".into(), width: 1728, height: 1080, bytes: 1 };
        let old = encode_png(&picture(1, 160, 100)).unwrap();
        assert_eq!(png_dimensions(&old), Some((160, 100)));
        assert!(thumb_is_stale(&old, &big));
        let current = make_thumb(&picture(1, 1728, 1080)).unwrap();
        assert_eq!(png_dimensions(&current), Some((THUMB_SIZE, 300)));
        assert!(!thumb_is_stale(&current, &big));
        // A picture smaller than the box never gets a bigger thumbnail.
        let small = ClipImage { hash: "s".into(), width: 120, height: 80, bytes: 1 };
        assert!(!thumb_is_stale(&encode_png(&picture(1, 120, 80)).unwrap(), &small));
        assert!(thumb_is_stale(b"not a png", &small));
    }

    #[test]
    fn picker_covers_about_two_thirds_of_the_display() {
        // A 1512x945 MacBook work area.
        let (width, height) = picker_size(1512.0, 945.0);
        assert!(width >= 1512.0 * 0.6 && width <= 1512.0 * 0.7);
        assert!(height >= 945.0 * 0.6 && height <= 945.0 * 0.8);
        // Small screens still fit; huge ones stop growing.
        let (width, height) = picker_size(800.0, 560.0);
        assert!(width <= 800.0 && height <= 560.0);
        assert_eq!(picker_size(5120.0, 2880.0), (1500.0, 940.0));
    }

    #[test]
    fn empty_broken_and_oversized_images_are_skipped() {
        assert!(prepare_image(RawImage::Dib(dib_of(&image::RgbaImage::new(0, 0)))).is_none());
        assert!(prepare_image(RawImage::Png(b"not a png".to_vec())).is_none());
        // Headers claiming too many pixels are refused before any copy.
        let mut huge_dib = dib_of(&picture(1, 2, 2));
        huge_dib[4..8].copy_from_slice(&8000u32.to_le_bytes());
        huge_dib[8..12].copy_from_slice(&(-6000i32).to_le_bytes());
        assert!(!header_fits(&huge_dib, false));
        assert!(prepare_image(RawImage::Dib(huge_dib)).is_none());
        let mut huge_png = encode_png(&picture(1, 2, 2)).unwrap();
        huge_png[16..20].copy_from_slice(&8000u32.to_be_bytes());
        huge_png[20..24].copy_from_slice(&6000u32.to_be_bytes());
        assert!(!header_fits(&huge_png, true));
        assert!(prepare_image(RawImage::Png(huge_png)).is_none());
        assert!(header_fits(&dib_of(&picture(1, 2, 2)), false));
        assert!(header_fits(&encode_png(&picture(1, 2, 2)).unwrap(), true));
        assert!(!header_fits(b"short", false));
        assert!(!header_fits(b"not a png at all, longer than 24", true));
        assert!(image_fits(6016, 3384));
        assert!(!image_fits(8000, 6000));
        assert!(!image_fits(0, 10));
    }

    #[test]
    fn an_image_without_text_is_kept_and_oversized_text_beside_it_is_dropped() {
        let mut entries = Vec::new();
        assert!(push_entry(&mut entries, "x".repeat(MAX_TEXT_BYTES + 1), Some(image_info("a", 10)), 1));
        assert_eq!(entries[0].text, "");
        assert!(push_entry(&mut entries, " ".into(), Some(image_info("b", 10)), 2));
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn oldest_images_go_first_past_the_disk_budget() {
        let mut entries = Vec::new();
        let third = MAX_IMAGE_BYTES_TOTAL / 3 + 1;
        push_entry(&mut entries, String::new(), Some(image_info("old", third)), 1);
        push_entry(&mut entries, "text".into(), None, 2);
        push_entry(&mut entries, String::new(), Some(image_info("mid", third)), 3);
        push_entry(&mut entries, String::new(), Some(image_info("new", third)), 4);
        let hashes: Vec<_> = entries.iter().filter_map(|e| e.image.as_ref()).map(|i| i.hash.as_str()).collect();
        assert_eq!(hashes, ["new", "mid"]);
        assert!(entries.iter().any(|e| e.text == "text"));
        // One image larger than the whole budget is still the one just copied.
        push_entry(&mut entries, String::new(), Some(image_info("huge", MAX_IMAGE_BYTES_TOTAL * 2)), 5);
        let hashes: Vec<_> = entries.iter().filter_map(|e| e.image.as_ref()).map(|i| i.hash.as_str()).collect();
        assert_eq!(hashes, ["huge"]);
    }

    #[test]
    fn image_files_follow_the_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let images = dir.path().join(IMAGES_DIR);
        let history = ClipboardHistory::load(Some(path.clone()), true);
        let first = prepare_image(png_of(picture(1, 8, 8))).unwrap();
        let second = prepare_image(png_of(picture(2, 8, 8))).unwrap();
        let (first_hash, second_hash) = (first.info.hash.clone(), second.info.hash.clone());
        assert!(history.record(String::new(), Some(first)));
        assert!(history.record("with text".into(), Some(second)));
        assert!(image_path(&images, &first_hash).exists());
        assert!(thumb_path(&images, &second_hash).exists());
        // A leftover from a crash is swept on the next change.
        std::fs::write(images.join("leftover.tmp"), b"x").unwrap();

        let reloaded = ClipboardHistory::load(Some(path), true);
        let entries = reloaded.snapshot();
        assert_eq!(entries[0].image.as_ref().unwrap().hash, second_hash);
        assert_eq!(entries[0].text, "with text");
        let first_id = entries[1].id;
        assert_eq!(reloaded.image_file(first_id, false).unwrap(), image_path(&images, &first_hash));

        reloaded.remove(first_id).unwrap();
        assert!(!image_path(&images, &first_hash).exists());
        assert!(!thumb_path(&images, &first_hash).exists());
        assert!(!images.join("leftover.tmp").exists());
        assert!(image_path(&images, &second_hash).exists());

        reloaded.clear().unwrap();
        assert!(!images.exists());
    }

    #[test]
    fn history_written_before_images_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, br#"[{"id":1,"text":"old","copiedAt":5}]"#).unwrap();
        let history = ClipboardHistory::load(Some(path), true);
        assert_eq!(history.snapshot(), [ClipEntry { id: 1, text: "old".into(), image: None, favorite: false, copied_at: 5 }]);
    }

    fn ids_of(entries: &[ClipEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.text.as_str()).collect()
    }

    #[test]
    fn favorites_survive_clear_all_and_a_repeat_copy() {
        let dir = tempfile::tempdir().unwrap();
        let history = ClipboardHistory::load(Some(dir.path().join(FILE_NAME)), true);
        history.record("keep me".into(), None);
        let id = history.snapshot()[0].id;
        history.set_favorite(id, true).unwrap();
        {
            // Fill to the cap directly: recording 10,000 copies writes the
            // history file 10,000 times.
            let mut entries = history.entries.lock();
            for i in 0..(MAX_ENTRIES + 5) {
                push_entry(&mut entries, format!("item {i}"), None, now_ms());
            }
        }
        let entries = history.snapshot();
        assert_eq!(entries.len(), MAX_ENTRIES + 1);
        assert!(entries.iter().any(|e| e.text == "keep me" && e.favorite));

        // Copying it again moves it up and keeps the star.
        history.record("keep me".into(), None);
        let top = &history.snapshot()[0];
        assert_eq!((top.text.as_str(), top.favorite), ("keep me", true));

        history.clear().unwrap();
        assert_eq!(ids_of(&history.snapshot()), ["keep me"]);
        // Turning history off still deletes everything.
        history.disable_and_clear().unwrap();
        assert!(history.snapshot().is_empty());
    }

    #[test]
    fn unstarring_brings_the_image_budget_back() {
        let mut entries = Vec::new();
        push_entry(&mut entries, String::new(), Some(image_info("old", MAX_IMAGE_BYTES_TOTAL)), 1);
        let old = entries[0].id;
        set_favorite(&mut entries, old, true, 2).unwrap();
        push_entry(&mut entries, String::new(), Some(image_info("new", MAX_IMAGE_BYTES_TOTAL)), 2);
        // The favorite does not count toward the budget.
        assert_eq!(entries.len(), 2);
        set_favorite(&mut entries, old, false, 2).unwrap();
        let hashes: Vec<_> = entries.iter().filter_map(|e| e.image.as_ref()).map(|i| i.hash.as_str()).collect();
        assert_eq!(hashes, ["new"]);
        assert!(set_favorite(&mut entries, 999, true, 2).is_err());
    }

    #[test]
    fn editing_changes_text_in_place_and_merges_duplicates() {
        let mut entries = Vec::new();
        push_entry(&mut entries, "first".into(), None, 1);
        push_entry(&mut entries, "secnd".into(), None, 2);
        push_entry(&mut entries, String::new(), Some(image_info("a", 1)), 3);
        let (image, second, first) = (entries[0].id, entries[1].id, entries[2].id);
        edit_text(&mut entries, second, "second".into()).unwrap();
        assert_eq!(ids_of(&entries), ["", "second", "first"]);
        assert_eq!(entries[1].copied_at, 2);

        assert!(edit_text(&mut entries, second, "  ".into()).is_err());
        assert!(edit_text(&mut entries, second, "x".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(edit_text(&mut entries, image, "caption".into()).is_err());
        assert!(edit_text(&mut entries, 999, "x".into()).is_err());

        // Editing into another item's text leaves one item, keeping its star.
        set_favorite(&mut entries, first, true, 10).unwrap();
        edit_text(&mut entries, second, "first".into()).unwrap();
        assert_eq!(ids_of(&entries), ["", "first"]);
        assert_eq!(entries[1].id, second);
        assert!(entries[1].favorite);
    }

    #[test]
    fn images_dropped_for_the_budget_leave_room_for_text() {
        let mut entries = Vec::new();
        for i in 0..MAX_ENTRIES - 2 {
            push_entry(&mut entries, format!("text {i}"), None, i as i64);
        }
        let half = MAX_IMAGE_BYTES_TOTAL / 2 + 1;
        for (i, hash) in ["a", "b", "c"].into_iter().enumerate() {
            push_entry(&mut entries, String::new(), Some(image_info(hash, half)), 1000 + i as i64);
        }
        // Only the newest image fits the budget; the other two go, and every
        // text item stays, under the item cap.
        let images: Vec<_> = entries.iter().filter_map(|e| e.image.as_ref()).map(|i| i.hash.as_str()).collect();
        assert_eq!(images, ["c"]);
        assert_eq!(entries.len(), MAX_ENTRIES - 1);
        assert!(entries.iter().any(|e| e.text == "text 0"));
    }

    #[test]
    fn the_same_picture_copied_again_with_new_text_keeps_the_new_text() {
        let mut entries = Vec::new();
        assert!(push_entry(&mut entries, "caption".into(), Some(image_info("a", 1)), 1));
        assert!(push_entry(&mut entries, String::new(), Some(image_info("a", 1)), 2));
        assert_eq!(entries.len(), 1);
        assert_eq!((entries[0].text.as_str(), entries[0].copied_at), ("", 2));
        // Same picture and same text: only the time moves.
        assert!(push_entry(&mut entries, String::new(), Some(image_info("a", 1)), 3));
        assert_eq!(entries.len(), 1);
        assert_eq!((entries[0].text.as_str(), entries[0].copied_at), ("", 3));
    }

    #[test]
    fn the_budget_counts_the_png_already_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let history = ClipboardHistory::load(Some(dir.path().join(FILE_NAME)), true);
        let first = prepare_image(png_of(picture(5, 20, 20))).unwrap();
        let stored = first.png.len() as u64;
        assert!(history.record(String::new(), Some(first)));
        history.record("text".into(), None);
        // Same pixels, a different encoding: the file on disk stays, and so
        // does the size the budget counts.
        let mut again = prepare_image(png_of(picture(5, 20, 20))).unwrap();
        again.png.extend_from_slice(&[0; 64]);
        again.info.bytes = again.png.len() as u64;
        assert!(history.record(String::new(), Some(again)));
        let entries = history.snapshot();
        assert_eq!(entries[0].image.as_ref().unwrap().bytes, stored);
    }
}
