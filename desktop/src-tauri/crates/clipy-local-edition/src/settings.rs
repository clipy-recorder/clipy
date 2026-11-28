//! Local edition settings: who reads the transcript for spoken cues, how a
//! recording is transcribed, and the keys for both.
//!
//! The wire shapes are the contract in `desktop/src/edition-local/settings-api.ts`
//! (camelCase fields, the exact enum strings below). The preset, model names
//! and base URL are stored in the app's `settings.json`; keys are stored in a
//! separate owner-only key file ([`KeyFile`]) and never appear in a DTO,
//! a `Debug` string or an error message.

use std::collections::BTreeMap;
use std::fmt;

use clipy_local_moments::{Preset, ProviderConfig as ModelConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::disclosure::Recipient;
use crate::text::nonempty;

/// Which desktop the settings are for. The Mac transcribes with Apple
/// Speech; Windows with a downloaded model or a provider key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    /// Linux and other test hosts: every kind is allowed.
    Other,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Other
        }
    }

    /// What the UI calls this machine (the app's `DEVICE`).
    pub fn device(self) -> &'static str {
        match self {
            Platform::Windows => "PC",
            _ => "Mac",
        }
    }
}

/// Who reads the transcript for spoken cues. `None` is rules only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ModelPreset {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "groq")]
    Groq,
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "lmstudio")]
    LmStudio,
    #[serde(rename = "custom")]
    Custom,
}

impl ModelPreset {
    /// The planner crate's preset; None for rules only.
    pub fn planner_preset(self) -> Option<Preset> {
        Some(match self {
            ModelPreset::None => return None,
            ModelPreset::OpenRouter => Preset::OpenRouter,
            ModelPreset::OpenAi => Preset::OpenAi,
            ModelPreset::Gemini => Preset::Gemini,
            ModelPreset::Groq => Preset::Groq,
            ModelPreset::Ollama => Preset::Ollama,
            ModelPreset::LmStudio => Preset::LmStudio,
            ModelPreset::Custom => Preset::Custom,
        })
    }

    /// The URL a key for this preset would be sent to: the override, else
    /// the preset's own. None for rules only and for custom without a URL.
    fn effective_url(self, base_url: Option<&str>) -> Option<String> {
        let preset = self.planner_preset()?;
        nonempty(base_url).or_else(|| preset.base_url().map(str::to_string))
    }
}

/// How a recording is transcribed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TranscriptionKind {
    /// Apple Speech on this Mac.
    #[serde(rename = "apple")]
    Apple,
    /// A downloaded model on this PC.
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "groq")]
    Groq,
    #[serde(rename = "deepgram")]
    Deepgram,
    #[serde(rename = "assemblyai")]
    AssemblyAi,
    #[serde(rename = "elevenlabs")]
    ElevenLabs,
    #[serde(rename = "gemini")]
    Gemini,
    /// No transcript.
    #[serde(rename = "none")]
    None,
}

impl TranscriptionKind {
    pub const PROVIDERS: [TranscriptionKind; 6] = [
        TranscriptionKind::OpenAi,
        TranscriptionKind::Groq,
        TranscriptionKind::Deepgram,
        TranscriptionKind::AssemblyAi,
        TranscriptionKind::ElevenLabs,
        TranscriptionKind::Gemini,
    ];

    /// The wire id, also the key file's slot name.
    pub fn id(self) -> &'static str {
        match self {
            TranscriptionKind::Apple => "apple",
            TranscriptionKind::Local => "local",
            TranscriptionKind::OpenAi => "openai",
            TranscriptionKind::Groq => "groq",
            TranscriptionKind::Deepgram => "deepgram",
            TranscriptionKind::AssemblyAi => "assemblyai",
            TranscriptionKind::ElevenLabs => "elevenlabs",
            TranscriptionKind::Gemini => "gemini",
            TranscriptionKind::None => "none",
        }
    }

    /// A hosted provider that receives the audio with the user's key.
    pub fn is_provider(self) -> bool {
        Self::PROVIDERS.contains(&self)
    }

    /// Display name of a hosted provider.
    pub fn provider_name(self) -> Option<&'static str> {
        Some(match self {
            TranscriptionKind::OpenAi => "OpenAI",
            TranscriptionKind::Groq => "Groq",
            TranscriptionKind::Deepgram => "Deepgram",
            TranscriptionKind::AssemblyAi => "AssemblyAI",
            TranscriptionKind::ElevenLabs => "ElevenLabs",
            TranscriptionKind::Gemini => "Gemini",
            _ => return None,
        })
    }

    /// Host the audio goes to (the provider's default endpoint, which is the
    /// only one the app uses; `stt_hosts_match_the_crate` checks them).
    pub fn provider_host(self) -> Option<&'static str> {
        Some(match self {
            TranscriptionKind::OpenAi => "api.openai.com",
            TranscriptionKind::Groq => "api.groq.com",
            TranscriptionKind::Deepgram => "api.deepgram.com",
            TranscriptionKind::AssemblyAi => "api.assemblyai.com",
            TranscriptionKind::ElevenLabs => "api.elevenlabs.io",
            TranscriptionKind::Gemini => "generativelanguage.googleapis.com",
            _ => return None,
        })
    }

    /// Kinds this platform can run. The Mac transcribes with Apple Speech
    /// only (the transcription crate is not in the Mac build); Windows has no
    /// Apple Speech.
    pub fn allowed_on(self, platform: Platform) -> bool {
        match platform {
            Platform::Mac => self == TranscriptionKind::Apple,
            Platform::Windows => self != TranscriptionKind::Apple,
            Platform::Other => true,
        }
    }
}

/// Downloadable on-device transcription models (Windows).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum LocalModelId {
    #[serde(rename = "english-fast")]
    EnglishFast,
    #[serde(rename = "multilingual")]
    Multilingual,
}

impl LocalModelId {
    pub const ALL: [LocalModelId; 2] = [LocalModelId::EnglishFast, LocalModelId::Multilingual];

    pub fn id(self) -> &'static str {
        match self {
            LocalModelId::EnglishFast => "english-fast",
            LocalModelId::Multilingual => "multilingual",
        }
    }

    /// Same as `clipy_local_stt`'s model label (`model_rows_match_the_crate`).
    pub fn label(self) -> &'static str {
        match self {
            LocalModelId::EnglishFast => "English, fast (Parakeet TDT-CTC 110M)",
            LocalModelId::Multilingual => "All languages (Whisper base)",
        }
    }

    /// Total download size in bytes, as `clipy_local_stt` pins it.
    pub fn size_bytes(self) -> u64 {
        match self {
            LocalModelId::EnglishFast => 104_337_827,
            LocalModelId::Multilingual => 160_609_290,
        }
    }

    /// Share of the progress fraction `clipy_local_stt::download_model`
    /// reports for the download itself; the rest is unpacking and checking
    /// an archive. Only english-fast comes as an archive.
    fn download_share(self) -> f64 {
        match self {
            LocalModelId::EnglishFast => 0.85,
            LocalModelId::Multilingual => 1.0,
        }
    }

    #[cfg(feature = "stt")]
    pub fn to_stt(self) -> clipy_local_stt::LocalModelId {
        match self {
            LocalModelId::EnglishFast => clipy_local_stt::LocalModelId::EnglishFast,
            LocalModelId::Multilingual => clipy_local_stt::LocalModelId::Multilingual,
        }
    }
}

// ---------------------------------------------------------------------------
// Stored settings (settings.json, no keys)
// ---------------------------------------------------------------------------

/// The store key under which the settings live in `settings.json`.
pub const STORE_KEY: &str = "local_edition";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredModel {
    pub preset: ModelPreset,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTranscription {
    pub kind: TranscriptionKind,
    #[serde(default)]
    pub local_model: Option<LocalModelId>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSettings {
    pub model: StoredModel,
    pub transcription: StoredTranscription,
}

impl StoredModel {
    pub fn rules_only() -> Self {
        StoredModel {
            preset: ModelPreset::None,
            model: None,
            base_url: None,
        }
    }

    /// The preset's own URL needs no override; rules only has neither.
    fn normalized(mut self) -> Self {
        self.model = nonempty(self.model.as_deref());
        self.base_url = nonempty(self.base_url.as_deref());
        if self.preset == ModelPreset::None {
            self.model = None;
            self.base_url = None;
        }
        self
    }

    fn validate(&self) -> Result<(), String> {
        let Some(preset) = self.preset.planner_preset() else {
            return Ok(());
        };
        if self.preset == ModelPreset::Custom && self.base_url.is_none() {
            return Err("A custom model provider needs a base URL.".into());
        }
        if let Some(url) = &self.base_url {
            if !is_http_url(url) {
                return Err("The model base URL must be an http:// or https:// URL.".into());
            }
        }
        if matches!(
            self.preset,
            ModelPreset::Custom | ModelPreset::Ollama | ModelPreset::LmStudio
        ) && self.model.is_none()
        {
            return Err(format!(
                "{} needs a model name, for example the name of a model you have pulled or loaded.",
                preset_name(preset)
            ));
        }
        Ok(())
    }

    fn effective_url(&self) -> Option<String> {
        self.preset.effective_url(self.base_url.as_deref())
    }
}

impl StoredTranscription {
    pub fn default_for(platform: Platform) -> Self {
        match platform {
            Platform::Mac => StoredTranscription {
                kind: TranscriptionKind::Apple,
                local_model: None,
                model: None,
            },
            _ => StoredTranscription {
                kind: TranscriptionKind::Local,
                local_model: Some(LocalModelId::EnglishFast),
                model: None,
            },
        }
    }

    fn normalized(mut self) -> Self {
        self.model = if self.kind.is_provider() {
            nonempty(self.model.as_deref())
        } else {
            None
        };
        if self.kind != TranscriptionKind::Local {
            self.local_model = None;
        }
        self
    }

    fn validate(&self, platform: Platform) -> Result<(), String> {
        if !self.kind.allowed_on(platform) {
            return Err(match self.kind {
                TranscriptionKind::Apple => "Apple Speech is only available on a Mac.".into(),
                TranscriptionKind::Local => {
                    "Downloaded transcription models are only available on Windows.".into()
                }
                _ => "This Mac transcribes on the device with Apple Speech.".into(),
            });
        }
        if self.kind == TranscriptionKind::Local && self.local_model.is_none() {
            return Err("Choose which transcription model to use.".into());
        }
        Ok(())
    }
}

impl StoredSettings {
    pub fn defaults(platform: Platform) -> Self {
        StoredSettings {
            model: StoredModel::rules_only(),
            transcription: StoredTranscription::default_for(platform),
        }
    }

    /// Read what `settings.json` holds under [`STORE_KEY`]. Anything missing,
    /// unreadable or not valid on this platform reads as the default for its
    /// section, so a hand-edited file can never make a provider appear.
    pub fn from_value(value: Option<&Value>, platform: Platform) -> Self {
        let mut settings = Self::defaults(platform);
        let Some(value) = value else {
            return settings;
        };
        if let Some(model) = value
            .get("model")
            .and_then(|v| serde_json::from_value::<StoredModel>(v.clone()).ok())
            .map(StoredModel::normalized)
            .filter(|m| m.validate().is_ok())
        {
            settings.model = model;
        }
        if let Some(transcription) = value
            .get("transcription")
            .and_then(|v| serde_json::from_value::<StoredTranscription>(v.clone()).ok())
            .map(StoredTranscription::normalized)
            .filter(|t| t.validate(platform).is_ok())
        {
            settings.transcription = transcription;
        }
        settings
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

fn is_http_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|u| (u.scheme() == "http" || u.scheme() == "https") && u.host_str().is_some())
}

fn host_of(value: &str) -> Option<String> {
    url::Url::parse(value)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
}

fn preset_name(preset: Preset) -> &'static str {
    match preset {
        Preset::Custom => "A custom model provider",
        other => other.name(),
    }
}

// ---------------------------------------------------------------------------
// Keys (owner-only key file, never returned)
// ---------------------------------------------------------------------------

/// The model provider key, bound to the preset and URL it was saved for, so
/// it is never sent to another host after the settings change.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelKey {
    pub preset: ModelPreset,
    pub base_url: String,
    pub key: String,
}

/// Everything in the key file. One model key, and one transcription key per
/// provider kind.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelKey>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub transcription: BTreeMap<String, String>,
}

impl fmt::Debug for KeyFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyFile")
            .field(
                "model",
                &self
                    .model
                    .as_ref()
                    .map(|m| (m.preset, &m.base_url, "<redacted>")),
            )
            .field(
                "transcription",
                &self.transcription.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl KeyFile {
    /// An unreadable key file reads as empty: the user is asked for keys
    /// again rather than a key being guessed.
    pub fn from_bytes(bytes: Option<&[u8]>) -> Self {
        bytes
            .and_then(|b| serde_json::from_slice(b).ok())
            .unwrap_or_default()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.transcription.is_empty()
    }

    /// The model key for these settings: only when it was saved for the same
    /// preset and the same URL.
    pub fn model_key(&self, model: &StoredModel) -> Option<&str> {
        let saved = self.model.as_ref()?;
        let url = model.effective_url()?;
        (saved.preset == model.preset && saved.base_url == url).then_some(saved.key.as_str())
    }

    pub fn transcription_key(&self, kind: TranscriptionKind) -> Option<&str> {
        if !kind.is_provider() {
            return None;
        }
        self.transcription.get(kind.id()).map(String::as_str)
    }
}

/// What a save does with a stored key.
#[derive(Clone, Default, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum KeyUpdate {
    #[default]
    Keep,
    Clear,
    Set {
        value: String,
    },
}

impl fmt::Debug for KeyUpdate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyUpdate::Keep => write!(f, "Keep"),
            KeyUpdate::Clear => write!(f, "Clear"),
            KeyUpdate::Set { .. } => write!(f, "Set(<redacted>)"),
        }
    }
}

impl KeyUpdate {
    /// The new key, trimmed. An empty `set` is refused rather than stored.
    fn new_key(&self) -> Result<Option<String>, String> {
        match self {
            KeyUpdate::Set { value } => nonempty(Some(value))
                .map(Some)
                .ok_or_else(|| "The API key is empty.".to_string()),
            _ => Ok(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Save requests and DTOs (settings-api.ts)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelSettings {
    pub preset: ModelPreset,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: KeyUpdate,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTranscriptionSettings {
    pub kind: TranscriptionKind,
    #[serde(default)]
    pub local_model: Option<LocalModelId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: KeyUpdate,
}

/// The `settings` argument of `save_local_settings`. An absent section is
/// left unchanged.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocalSettingsRequest {
    #[serde(default)]
    pub model: Option<SaveModelSettings>,
    #[serde(default)]
    pub transcription: Option<SaveTranscriptionSettings>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingsDto {
    pub preset: ModelPreset,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub has_api_key: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSettingsDto {
    pub kind: TranscriptionKind,
    pub local_model: Option<LocalModelId>,
    pub model: Option<String>,
    pub has_api_key: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSettingsDto {
    pub model: ModelSettingsDto,
    pub transcription: TranscriptionSettingsDto,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatusDto {
    pub id: LocalModelId,
    pub label: &'static str,
    pub size_bytes: u64,
    pub installed: bool,
    pub downloading: bool,
}

impl LocalModelStatusDto {
    pub fn new(id: LocalModelId, installed: bool, downloading: bool) -> Self {
        LocalModelStatusDto {
            id,
            label: id.label(),
            size_bytes: id.size_bytes(),
            installed,
            downloading,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressStage {
    Downloading,
    Verifying,
    Installed,
    Failed,
}

/// Payload of the `local-model-progress` event.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelProgressDto {
    pub model: LocalModelId,
    pub stage: ProgressStage,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

/// The event name of [`LocalModelProgressDto`].
pub const EVENT_LOCAL_MODEL_PROGRESS: &str = "local-model-progress";

impl LocalModelProgressDto {
    /// A running download at `fraction` (0..=1 as `download_model` reports
    /// it). Past the download share the files are being unpacked and
    /// checked: `verifying`, with every byte received.
    pub fn running(model: LocalModelId, fraction: f64) -> Self {
        let total = model.size_bytes();
        let fraction = if fraction.is_finite() {
            fraction.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let share = model.download_share();
        let downloaded = (fraction / share).min(1.0);
        LocalModelProgressDto {
            model,
            stage: if fraction >= share {
                ProgressStage::Verifying
            } else {
                ProgressStage::Downloading
            },
            received_bytes: (downloaded * total as f64).round() as u64,
            total_bytes: total,
            error: None,
        }
    }

    pub fn installed(model: LocalModelId) -> Self {
        LocalModelProgressDto {
            model,
            stage: ProgressStage::Installed,
            received_bytes: model.size_bytes(),
            total_bytes: model.size_bytes(),
            error: None,
        }
    }

    pub fn failed(model: LocalModelId, error: impl Into<String>) -> Self {
        LocalModelProgressDto {
            model,
            stage: ProgressStage::Failed,
            received_bytes: 0,
            total_bytes: model.size_bytes(),
            error: Some(error.into()),
        }
    }
}

/// Read back what is stored, as the WebView sees it.
pub fn to_dto(settings: &StoredSettings, keys: &KeyFile) -> LocalSettingsDto {
    let model = &settings.model;
    LocalSettingsDto {
        model: ModelSettingsDto {
            preset: model.preset,
            model: model.model.clone(),
            base_url: model.base_url.clone(),
            has_api_key: keys.model_key(model).is_some(),
        },
        transcription: TranscriptionSettingsDto {
            kind: settings.transcription.kind,
            local_model: settings.transcription.local_model,
            model: settings.transcription.model.clone(),
            has_api_key: keys
                .transcription_key(settings.transcription.kind)
                .is_some(),
        },
    }
}

/// Apply a save: validate, then return the new settings and key file.
/// Nothing is applied when a section is invalid. Errors never hold a key.
pub fn apply_save(
    settings: &StoredSettings,
    keys: &KeyFile,
    request: &SaveLocalSettingsRequest,
    platform: Platform,
) -> Result<(StoredSettings, KeyFile), String> {
    let mut next = settings.clone();
    let mut next_keys = keys.clone();

    if let Some(save) = &request.model {
        let model = StoredModel {
            preset: save.preset,
            model: save.model.clone(),
            base_url: save.base_url.clone(),
        }
        .normalized();
        model.validate()?;
        let new_key = save.api_key.new_key()?;
        // The stored key survives only when it still belongs to these
        // settings: same preset and same URL. `keep` can never carry a key
        // to another host.
        let kept = match &save.api_key {
            KeyUpdate::Keep => next_keys.model_key(&model).map(str::to_string),
            _ => None,
        };
        next_keys.model = match (model.effective_url(), new_key.or(kept)) {
            (Some(base_url), Some(key)) => Some(ModelKey {
                preset: model.preset,
                base_url,
                key,
            }),
            _ => None,
        };
        next.model = model;
    }

    if let Some(save) = &request.transcription {
        let transcription = StoredTranscription {
            kind: save.kind,
            local_model: save.local_model,
            model: save.model.clone(),
        }
        .normalized();
        transcription.validate(platform)?;
        let new_key = save.api_key.new_key()?;
        if transcription.kind.is_provider() {
            let slot = transcription.kind.id().to_string();
            match (&save.api_key, new_key) {
                (KeyUpdate::Clear, _) => {
                    next_keys.transcription.remove(&slot);
                }
                (_, Some(key)) => {
                    next_keys.transcription.insert(slot, key);
                }
                _ => {}
            }
        }
        next.transcription = transcription;
    }

    Ok((next, next_keys))
}

// ---------------------------------------------------------------------------
// What a recording uses
// ---------------------------------------------------------------------------

/// Who picks spoken cues for this recording.
pub enum MomentProvider {
    /// No model provider: rules on this computer only.
    RulesOnly,
    /// A provider is chosen but cannot run (no key, say). Rules only, and the
    /// AREC says why.
    Unusable { message: String },
    /// Ask this provider. `recipient` names where the text goes.
    Ready {
        config: ModelConfig,
        recipient: Recipient,
    },
}

impl fmt::Debug for MomentProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MomentProvider::RulesOnly => write!(f, "RulesOnly"),
            MomentProvider::Unusable { message } => write!(f, "Unusable({message})"),
            MomentProvider::Ready { config, recipient } => {
                write!(f, "Ready({config:?}, {recipient:?})")
            }
        }
    }
}

pub fn moment_provider(settings: &StoredSettings, keys: &KeyFile) -> MomentProvider {
    let model = &settings.model;
    let Some(preset) = model.preset.planner_preset() else {
        return MomentProvider::RulesOnly;
    };
    let name = preset_name(preset);
    if let Err(message) = model.validate() {
        return MomentProvider::Unusable { message };
    }
    let key = keys.model_key(model);
    if key.is_none() && preset != Preset::Custom && !preset.is_local() {
        return MomentProvider::Unusable {
            message: format!("{name} needs an API key. Add it in Settings."),
        };
    }
    match ModelConfig::from_preset(
        preset,
        key,
        model.model.as_deref(),
        model.base_url.as_deref(),
    ) {
        Ok(config) => {
            let host = config.host().unwrap_or_else(|| "an unknown host".into());
            MomentProvider::Ready {
                config,
                recipient: Recipient {
                    name: name_for_recipient(preset).into(),
                    host,
                },
            }
        }
        Err(_) => MomentProvider::Unusable {
            message: format!(
                "The {} settings are incomplete. Check them in Settings.",
                name_for_recipient(preset)
            ),
        },
    }
}

fn name_for_recipient(preset: Preset) -> &'static str {
    match preset {
        Preset::Custom => "custom model provider",
        other => other.name(),
    }
}

/// How this recording is transcribed.
#[derive(Clone, Debug, PartialEq)]
pub enum TranscriptionPlan {
    /// Apple Speech on this Mac.
    Apple,
    /// A downloaded model on this PC.
    Local(LocalModelId),
    /// A provider with the user's key; the audio goes to `recipient`.
    Provider {
        kind: TranscriptionKind,
        recipient: Recipient,
    },
    /// No transcript.
    Off,
}

pub fn transcription_plan(settings: &StoredSettings) -> TranscriptionPlan {
    let t = &settings.transcription;
    match t.kind {
        TranscriptionKind::Apple => TranscriptionPlan::Apple,
        TranscriptionKind::Local => {
            TranscriptionPlan::Local(t.local_model.unwrap_or(LocalModelId::EnglishFast))
        }
        TranscriptionKind::None => TranscriptionPlan::Off,
        kind => TranscriptionPlan::Provider {
            kind,
            recipient: Recipient {
                name: kind.provider_name().unwrap_or("the provider").into(),
                host: kind.provider_host().unwrap_or("an unknown host").into(),
            },
        },
    }
}

/// The transcription crate's config for a keyed provider. The message of an
/// error is for the user and never holds the key.
#[cfg(feature = "stt")]
pub fn stt_config(
    kind: TranscriptionKind,
    model: Option<&str>,
    key: Option<&str>,
) -> Result<clipy_local_stt::ProviderConfig, String> {
    use clipy_local_stt::providers::{
        GROQ_BASE_URL, GROQ_DEFAULT_MODEL, OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL,
    };
    use clipy_local_stt::ProviderConfig as Stt;
    let name = kind
        .provider_name()
        .ok_or_else(|| "This transcription choice does not use a key.".to_string())?;
    let api_key = nonempty(key)
        .ok_or_else(|| format!("{name} needs an API key. Add it in Settings, then Retry."))?;
    let model = nonempty(model);
    Ok(match kind {
        TranscriptionKind::OpenAi => Stt::OpenAiCompatible {
            base_url: OPENAI_BASE_URL.into(),
            api_key,
            model: model.unwrap_or_else(|| OPENAI_DEFAULT_MODEL.into()),
        },
        TranscriptionKind::Groq => Stt::OpenAiCompatible {
            base_url: GROQ_BASE_URL.into(),
            api_key,
            model: model.unwrap_or_else(|| GROQ_DEFAULT_MODEL.into()),
        },
        TranscriptionKind::Deepgram => Stt::Deepgram {
            api_key,
            model,
            base_url: None,
        },
        TranscriptionKind::AssemblyAi => Stt::AssemblyAi {
            api_key,
            model,
            base_url: None,
        },
        TranscriptionKind::ElevenLabs => Stt::ElevenLabs {
            api_key,
            model,
            base_url: None,
        },
        TranscriptionKind::Gemini => Stt::Gemini {
            api_key,
            model,
            base_url: None,
        },
        _ => unreachable!("provider_name is Some only for providers"),
    })
}

/// Host part of a URL, for messages.
pub fn url_host(value: &str) -> Option<String> {
    host_of(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn save(value: Value) -> SaveLocalSettingsRequest {
        serde_json::from_value(value).unwrap()
    }

    fn windows() -> StoredSettings {
        StoredSettings::defaults(Platform::Windows)
    }

    #[test]
    fn defaults_match_the_contract() {
        let mac = to_dto(
            &StoredSettings::defaults(Platform::Mac),
            &KeyFile::default(),
        );
        assert_eq!(
            serde_json::to_value(&mac).unwrap(),
            json!({"model":{"preset":"none","model":null,"baseUrl":null,"hasApiKey":false},
                   "transcription":{"kind":"apple","localModel":null,"model":null,"hasApiKey":false}})
        );
        let win = to_dto(&windows(), &KeyFile::default());
        assert_eq!(
            serde_json::to_value(&win.transcription).unwrap(),
            json!({"kind":"local","localModel":"english-fast","model":null,"hasApiKey":false})
        );
    }

    #[test]
    fn every_wire_string_round_trips() {
        for (preset, id) in [
            (ModelPreset::None, "none"),
            (ModelPreset::OpenRouter, "openrouter"),
            (ModelPreset::OpenAi, "openai"),
            (ModelPreset::Gemini, "gemini"),
            (ModelPreset::Groq, "groq"),
            (ModelPreset::Ollama, "ollama"),
            (ModelPreset::LmStudio, "lmstudio"),
            (ModelPreset::Custom, "custom"),
        ] {
            assert_eq!(serde_json::to_value(preset).unwrap(), json!(id));
            assert_eq!(
                serde_json::from_value::<ModelPreset>(json!(id)).unwrap(),
                preset
            );
            if let Some(p) = preset.planner_preset() {
                assert_eq!(p.id(), id);
            }
        }
        for kind in [
            TranscriptionKind::Apple,
            TranscriptionKind::Local,
            TranscriptionKind::OpenAi,
            TranscriptionKind::Groq,
            TranscriptionKind::Deepgram,
            TranscriptionKind::AssemblyAi,
            TranscriptionKind::ElevenLabs,
            TranscriptionKind::Gemini,
            TranscriptionKind::None,
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.id()));
        }
        for model in LocalModelId::ALL {
            assert_eq!(serde_json::to_value(model).unwrap(), json!(model.id()));
        }
    }

    #[test]
    fn model_validation_follows_the_contract() {
        let base = windows();
        let keys = KeyFile::default();
        let err = |v: Value| apply_save(&base, &keys, &save(v), Platform::Windows).unwrap_err();
        assert!(err(json!({"model":{"preset":"custom","model":"m","baseUrl":null,"apiKey":{"action":"keep"}}}))
            .contains("base URL"));
        assert!(err(json!({"model":{"preset":"custom","model":null,"baseUrl":"https://x.test/v1","apiKey":{"action":"keep"}}}))
            .contains("model name"));
        assert!(err(json!({"model":{"preset":"ollama","model":" ","baseUrl":null,"apiKey":{"action":"keep"}}}))
            .contains("model name"));
        assert!(err(json!({"model":{"preset":"lmstudio","model":null,"baseUrl":null,"apiKey":{"action":"keep"}}}))
            .contains("model name"));
        assert!(err(json!({"model":{"preset":"openai","model":null,"baseUrl":"ftp://x","apiKey":{"action":"keep"}}}))
            .contains("http"));
        assert!(err(json!({"model":{"preset":"openai","model":null,"baseUrl":null,"apiKey":{"action":"set","value":"  "}}}))
            .contains("empty"));
        let (ok, _) = apply_save(
            &base,
            &keys,
            &save(json!({"model":{"preset":"ollama","model":"llama3","baseUrl":null,"apiKey":{"action":"keep"}}})),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(ok.model.model.as_deref(), Some("llama3"));
    }

    #[test]
    fn transcription_validation_follows_the_platform() {
        let keys = KeyFile::default();
        let mac = StoredSettings::defaults(Platform::Mac);
        let req = |kind: &str, local: Value| {
            save(
                json!({"transcription":{"kind":kind,"localModel":local,"model":null,"apiKey":{"action":"keep"}}}),
            )
        };
        assert!(apply_save(
            &mac,
            &keys,
            &req("local", json!("english-fast")),
            Platform::Mac
        )
        .unwrap_err()
        .contains("Windows"));
        assert!(apply_save(&mac, &keys, &req("deepgram", Value::Null), Platform::Mac).is_err());
        assert!(apply_save(&mac, &keys, &req("apple", Value::Null), Platform::Mac).is_ok());
        let win = windows();
        assert!(
            apply_save(&win, &keys, &req("apple", Value::Null), Platform::Windows)
                .unwrap_err()
                .contains("Mac")
        );
        assert!(apply_save(&win, &keys, &req("local", Value::Null), Platform::Windows).is_err());
        let (next, _) = apply_save(
            &win,
            &keys,
            &req("local", json!("multilingual")),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(
            next.transcription.local_model,
            Some(LocalModelId::Multilingual)
        );
        let (next, _) = apply_save(
            &win,
            &keys,
            &req("none", json!("multilingual")),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(next.transcription.local_model, None, "only kept for local");
    }

    #[test]
    fn absent_sections_are_left_unchanged() {
        let mut base = windows();
        base.model = StoredModel {
            preset: ModelPreset::Groq,
            model: Some("m".into()),
            base_url: None,
        };
        let (next, keys) = apply_save(
            &base,
            &KeyFile::default(),
            &save(json!({"transcription":{"kind":"none","localModel":null,"model":null,"apiKey":{"action":"keep"}}})),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(next.model, base.model);
        assert_eq!(next.transcription.kind, TranscriptionKind::None);
        assert!(keys.is_empty());
    }

    #[test]
    fn model_key_never_follows_a_preset_or_url_change() {
        let base = windows();
        let (s, k) = apply_save(
            &base,
            &KeyFile::default(),
            &save(json!({"model":{"preset":"openrouter","model":null,"baseUrl":null,"apiKey":{"action":"set","value":" sk-or-1 "}}})),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(k.model_key(&s.model), Some("sk-or-1"));
        assert!(to_dto(&s, &k).model.has_api_key);
        // Keep with the same preset keeps it.
        let (s2, k2) = apply_save(
            &s,
            &k,
            &save(json!({"model":{"preset":"openrouter","model":"x/y","baseUrl":null,"apiKey":{"action":"keep"}}})),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(k2.model_key(&s2.model), Some("sk-or-1"));
        // Keep with another preset drops it.
        let (s3, k3) = apply_save(
            &s2,
            &k2,
            &save(json!({"model":{"preset":"openai","model":null,"baseUrl":null,"apiKey":{"action":"keep"}}})),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(k3.model_key(&s3.model), None);
        assert!(k3.model.is_none());
        // A URL change under keep drops it too.
        let (s4, k4) = apply_save(
            &s2,
            &k2,
            &save(json!({"model":{"preset":"openrouter","model":null,"baseUrl":"https://evil.test/v1","apiKey":{"action":"keep"}}})),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(k4.model_key(&s4.model), None);
        // Clear removes it.
        let (_, k5) = apply_save(
            &s2,
            &k2,
            &save(json!({"model":{"preset":"openrouter","model":null,"baseUrl":null,"apiKey":{"action":"clear"}}})),
            Platform::Windows,
        )
        .unwrap();
        assert!(k5.model.is_none());
        // Rules only stores no key.
        let (_, k6) = apply_save(
            &s2,
            &k2,
            &save(json!({"model":{"preset":"none","model":null,"baseUrl":null,"apiKey":{"action":"set","value":"x"}}})),
            Platform::Windows,
        )
        .unwrap();
        assert!(k6.model.is_none());
    }

    #[test]
    fn transcription_keys_belong_to_their_kind() {
        let base = windows();
        let set = |kind: &str, action: Value| {
            save(
                json!({"transcription":{"kind":kind,"localModel":null,"model":null,"apiKey":action}}),
            )
        };
        let (s, k) = apply_save(
            &base,
            &KeyFile::default(),
            &set("deepgram", json!({"action":"set","value":"dg"})),
            Platform::Windows,
        )
        .unwrap();
        assert!(to_dto(&s, &k).transcription.has_api_key);
        let (s, k) = apply_save(
            &s,
            &k,
            &set("assemblyai", json!({"action":"keep"})),
            Platform::Windows,
        )
        .unwrap();
        assert!(
            !to_dto(&s, &k).transcription.has_api_key,
            "keep keeps nothing for a new kind"
        );
        let (s, k) = apply_save(
            &s,
            &k,
            &set("deepgram", json!({"action":"keep"})),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!(k.transcription_key(s.transcription.kind), Some("dg"));
        let (s, k) = apply_save(
            &s,
            &k,
            &set("deepgram", json!({"action":"clear"})),
            Platform::Windows,
        )
        .unwrap();
        assert!(!to_dto(&s, &k).transcription.has_api_key);
    }

    #[test]
    fn keys_never_reach_a_dto_or_debug_string() {
        let base = windows();
        let (s, k) = apply_save(
            &base,
            &KeyFile::default(),
            &save(json!({
                "model":{"preset":"openai","model":null,"baseUrl":null,"apiKey":{"action":"set","value":"SECRET-MODEL"}},
                "transcription":{"kind":"gemini","localModel":null,"model":null,"apiKey":{"action":"set","value":"SECRET-STT"}}
            })),
            Platform::Windows,
        )
        .unwrap();
        let dto = serde_json::to_string(&to_dto(&s, &k)).unwrap();
        assert!(!dto.contains("SECRET"));
        assert!(!format!("{k:?}").contains("SECRET"));
        assert!(!format!("{s:?}").contains("SECRET"));
        let provider = moment_provider(&s, &k);
        assert!(!format!("{provider:?}").contains("SECRET"));
        let update: KeyUpdate =
            serde_json::from_value(json!({"action":"set","value":"SECRET"})).unwrap();
        assert!(!format!("{update:?}").contains("SECRET"));
        // The key file itself holds them, and reads back.
        let again = KeyFile::from_bytes(Some(&k.to_bytes()));
        assert_eq!(again, k);
        assert_eq!(KeyFile::from_bytes(Some(b"not json")), KeyFile::default());
    }

    #[test]
    fn stored_settings_load_tolerantly() {
        let v = json!({"model":{"preset":"custom","model":"m","baseUrl":"https://h.test/v1"},
                       "transcription":{"kind":"apple"}});
        let win = StoredSettings::from_value(Some(&v), Platform::Windows);
        assert_eq!(win.model.preset, ModelPreset::Custom);
        assert_eq!(
            win.transcription,
            StoredTranscription::default_for(Platform::Windows)
        );
        let bad = json!({"model":{"preset":"custom"}, "transcription":"x"});
        assert_eq!(
            StoredSettings::from_value(Some(&bad), Platform::Mac),
            StoredSettings::defaults(Platform::Mac)
        );
        let round = StoredSettings::from_value(Some(&win.to_value()), Platform::Windows);
        assert_eq!(round, win);
    }

    #[test]
    fn settings_round_trip_all_presets_and_providers() {
        let presets_and_urls = [
            (ModelPreset::None, None, None, false),
            (ModelPreset::OpenRouter, Some("google/gemini-flash"), None, true),
            (ModelPreset::OpenAi, Some("gpt-4o-mini"), None, true),
            (ModelPreset::Gemini, Some("gemini-2.5-flash"), None, true),
            (ModelPreset::Groq, Some("llama-3.3-70b-versatile"), None, true),
            (ModelPreset::Ollama, Some("llama3"), Some("http://127.0.0.1:11434/v1"), false),
            (ModelPreset::LmStudio, Some("local-model"), Some("http://127.0.0.1:1234/v1"), false),
            (ModelPreset::Custom, Some("custom-model"), Some("https://api.example.com/v1"), true),
        ];

        let mut current_settings = StoredSettings::defaults(Platform::Windows);
        let mut current_keys = KeyFile::default();

        for (preset, model, base_url, needs_key) in presets_and_urls {
            let req = SaveLocalSettingsRequest {
                model: Some(SaveModelSettings {
                    preset,
                    model: model.map(str::to_string),
                    base_url: base_url.map(str::to_string),
                    api_key: if needs_key {
                        KeyUpdate::Set {
                            value: "test-secret-key-123".to_string(),
                        }
                    } else {
                        KeyUpdate::Keep
                    },
                }),
                transcription: None,
            };

            let (next_settings, next_keys) =
                apply_save(&current_settings, &current_keys, &req, Platform::Windows).unwrap();

            let dto = to_dto(&next_settings, &next_keys);
            assert_eq!(dto.model.preset, preset);
            assert_eq!(dto.model.model.as_deref(), model);
            assert_eq!(dto.model.has_api_key, needs_key);

            let stored_value = next_settings.to_value();
            let json_str = serde_json::to_string(&stored_value).unwrap();
            let parsed_value: Value = serde_json::from_str(&json_str).unwrap();
            let reloaded_settings =
                StoredSettings::from_value(Some(&parsed_value), Platform::Windows);
            assert_eq!(reloaded_settings, next_settings);

            let key_bytes = next_keys.to_bytes();
            let reloaded_keys = KeyFile::from_bytes(Some(&key_bytes));
            assert_eq!(reloaded_keys, next_keys);

            let reloaded_dto = to_dto(&reloaded_settings, &reloaded_keys);
            assert_eq!(reloaded_dto, dto);

            let keep_req = SaveLocalSettingsRequest {
                model: Some(SaveModelSettings {
                    preset,
                    model: model.map(str::to_string),
                    base_url: base_url.map(str::to_string),
                    api_key: KeyUpdate::Keep,
                }),
                transcription: None,
            };
            let (kept_settings, kept_keys) =
                apply_save(&next_settings, &next_keys, &keep_req, Platform::Windows).unwrap();
            assert_eq!(to_dto(&kept_settings, &kept_keys).model.has_api_key, needs_key);

            if needs_key {
                let clear_req = SaveLocalSettingsRequest {
                    model: Some(SaveModelSettings {
                        preset,
                        model: model.map(str::to_string),
                        base_url: base_url.map(str::to_string),
                        api_key: KeyUpdate::Clear,
                    }),
                    transcription: None,
                };
                let (cleared_settings, cleared_keys) =
                    apply_save(&kept_settings, &kept_keys, &clear_req, Platform::Windows).unwrap();
                assert!(!to_dto(&cleared_settings, &cleared_keys).model.has_api_key);
            }

            current_settings = next_settings;
            current_keys = next_keys;
        }

        let kinds_windows = [
            (TranscriptionKind::None, None, false),
            (TranscriptionKind::Local, Some(LocalModelId::EnglishFast), false),
            (TranscriptionKind::Local, Some(LocalModelId::Multilingual), false),
            (TranscriptionKind::OpenAi, None, true),
            (TranscriptionKind::Groq, None, true),
            (TranscriptionKind::Deepgram, None, true),
            (TranscriptionKind::AssemblyAi, None, true),
            (TranscriptionKind::ElevenLabs, None, true),
            (TranscriptionKind::Gemini, None, true),
        ];

        for (kind, local_model, needs_key) in kinds_windows {
            let req = SaveLocalSettingsRequest {
                model: None,
                transcription: Some(SaveTranscriptionSettings {
                    kind,
                    local_model,
                    model: if needs_key {
                        Some("whisper-1".into())
                    } else {
                        None
                    },
                    api_key: if needs_key {
                        KeyUpdate::Set {
                            value: "test-stt-key-456".to_string(),
                        }
                    } else {
                        KeyUpdate::Keep
                    },
                }),
            };

            let (next_settings, next_keys) =
                apply_save(&current_settings, &current_keys, &req, Platform::Windows).unwrap();

            let dto = to_dto(&next_settings, &next_keys);
            assert_eq!(dto.transcription.kind, kind);
            assert_eq!(dto.transcription.local_model, local_model);
            assert_eq!(dto.transcription.has_api_key, needs_key);

            let stored_value = next_settings.to_value();
            let json_str = serde_json::to_string(&stored_value).unwrap();
            let parsed_value: Value = serde_json::from_str(&json_str).unwrap();
            let reloaded_settings =
                StoredSettings::from_value(Some(&parsed_value), Platform::Windows);
            assert_eq!(reloaded_settings, next_settings);

            let key_bytes = next_keys.to_bytes();
            let reloaded_keys = KeyFile::from_bytes(Some(&key_bytes));
            assert_eq!(reloaded_keys, next_keys);

            assert_eq!(to_dto(&reloaded_settings, &reloaded_keys), dto);

            current_settings = next_settings;
            current_keys = next_keys;
        }

        let mac_settings = StoredSettings::defaults(Platform::Mac);
        let mac_keys = KeyFile::default();
        let mac_req = SaveLocalSettingsRequest {
            model: None,
            transcription: Some(SaveTranscriptionSettings {
                kind: TranscriptionKind::Apple,
                local_model: None,
                model: None,
                api_key: KeyUpdate::Keep,
            }),
        };
        let (next_mac, next_mac_keys) =
            apply_save(&mac_settings, &mac_keys, &mac_req, Platform::Mac).unwrap();
        assert_eq!(
            to_dto(&next_mac, &next_mac_keys).transcription.kind,
            TranscriptionKind::Apple
        );
        let reloaded_mac = StoredSettings::from_value(Some(&next_mac.to_value()), Platform::Mac);
        assert_eq!(reloaded_mac, next_mac);
    }

    #[test]
    fn settings_full_round_trip() {
        let base = windows();
        let keys = KeyFile::default();

        // 1. Model presets round-trip across save -> DTO -> disk serialize -> reload
        let model_cases = [
            ("none", None, None, false),
            ("openai", Some("gpt-4o"), Some("https://api.openai.com/v1"), true),
            ("openrouter", Some("anthropic/claude-3-opus"), None, true),
            ("gemini", Some("gemini-2.5-flash"), None, true),
            ("groq", Some("llama-3.3-70b-versatile"), None, true),
            ("ollama", Some("llama3"), Some("http://127.0.0.1:11434/v1"), false),
            ("lmstudio", Some("qwen2.5-coder"), Some("http://127.0.0.1:1234/v1"), false),
            ("custom", Some("custom-model"), Some("https://example.com/v1"), true),
        ];

        for (preset_str, model_opt, url_opt, has_key) in model_cases {
            let key_update = if has_key {
                json!({"action": "set", "value": "test-key-123"})
            } else {
                json!({"action": "clear"})
            };
            let req = save(json!({
                "model": {
                    "preset": preset_str,
                    "model": model_opt,
                    "baseUrl": url_opt,
                    "apiKey": key_update
                }
            }));
            let (next_settings, next_keys) = apply_save(&base, &keys, &req, Platform::Windows).unwrap();
            let dto = to_dto(&next_settings, &next_keys);
            assert_eq!(serde_json::to_value(dto.model.preset).unwrap(), json!(preset_str));
            assert_eq!(dto.model.has_api_key, has_key);

            // Round trip StoredSettings through JSON Value and string
            let json_str = serde_json::to_string(&next_settings.to_value()).unwrap();
            let parsed_val: Value = serde_json::from_str(&json_str).unwrap();
            let reloaded_settings = StoredSettings::from_value(Some(&parsed_val), Platform::Windows);
            assert_eq!(reloaded_settings, next_settings);

            // Round trip KeyFile through bytes
            let key_bytes = next_keys.to_bytes();
            let reloaded_keys = KeyFile::from_bytes(Some(&key_bytes));
            assert_eq!(reloaded_keys, next_keys);

            // Recomputed DTO matches
            let reloaded_dto = to_dto(&reloaded_settings, &reloaded_keys);
            assert_eq!(reloaded_dto, dto);
        }

        // 2. Transcription kinds round-trip across save -> DTO -> disk serialize -> reload
        let transcription_cases = [
            ("local", Some("english-fast"), None, false),
            ("local", Some("multilingual"), None, false),
            ("openai", None, Some("whisper-1"), true),
            ("groq", None, Some("whisper-large-v3"), true),
            ("deepgram", None, None, true),
            ("assemblyai", None, None, true),
            ("elevenlabs", None, None, true),
            ("gemini", None, None, true),
            ("none", None, None, false),
        ];

        for (kind_str, local_model_opt, model_opt, has_key) in transcription_cases {
            let key_update = if has_key {
                json!({"action": "set", "value": "test-stt-key-456"})
            } else {
                json!({"action": "clear"})
            };
            let req = save(json!({
                "transcription": {
                    "kind": kind_str,
                    "localModel": local_model_opt,
                    "model": model_opt,
                    "apiKey": key_update
                }
            }));
            let (next_settings, next_keys) = apply_save(&base, &keys, &req, Platform::Windows).unwrap();
            let dto = to_dto(&next_settings, &next_keys);
            assert_eq!(dto.transcription.kind.id(), kind_str);
            assert_eq!(dto.transcription.has_api_key, has_key);

            let json_str = serde_json::to_string(&next_settings.to_value()).unwrap();
            let parsed_val: Value = serde_json::from_str(&json_str).unwrap();
            let reloaded_settings = StoredSettings::from_value(Some(&parsed_val), Platform::Windows);
            assert_eq!(reloaded_settings, next_settings);

            let key_bytes = next_keys.to_bytes();
            let reloaded_keys = KeyFile::from_bytes(Some(&key_bytes));
            assert_eq!(reloaded_keys, next_keys);

            let reloaded_dto = to_dto(&reloaded_settings, &reloaded_keys);
            assert_eq!(reloaded_dto, dto);
        }

        // 3. Apple speech on Mac platform
        let mac_base = StoredSettings::defaults(Platform::Mac);
        let mac_req = save(json!({
            "transcription": {
                "kind": "apple",
                "localModel": null,
                "model": null,
                "apiKey": {"action": "keep"}
            }
        }));
        let (mac_next, mac_keys) = apply_save(&mac_base, &keys, &mac_req, Platform::Mac).unwrap();
        let mac_dto = to_dto(&mac_next, &mac_keys);
        assert_eq!(mac_dto.transcription.kind, TranscriptionKind::Apple);
        assert!(!mac_dto.transcription.has_api_key);
        let mac_json = serde_json::to_string(&mac_next.to_value()).unwrap();
        let mac_reloaded = StoredSettings::from_value(Some(&serde_json::from_str(&mac_json).unwrap()), Platform::Mac);
        assert_eq!(mac_reloaded, mac_next);
    }

    #[test]
    fn moment_provider_needs_what_the_preset_needs() {
        let mut s = windows();
        assert!(matches!(
            moment_provider(&s, &KeyFile::default()),
            MomentProvider::RulesOnly
        ));
        s.model = StoredModel {
            preset: ModelPreset::OpenRouter,
            model: None,
            base_url: None,
        };
        match moment_provider(&s, &KeyFile::default()) {
            MomentProvider::Unusable { message } => assert!(message.contains("needs an API key")),
            other => panic!("{other:?}"),
        }
        let keys = KeyFile {
            model: Some(ModelKey {
                preset: ModelPreset::OpenRouter,
                base_url: "https://openrouter.ai/api/v1".into(),
                key: "k".into(),
            }),
            ..KeyFile::default()
        };
        match moment_provider(&s, &keys) {
            MomentProvider::Ready { config, recipient } => {
                assert_eq!(recipient.host, "openrouter.ai");
                assert_eq!(recipient.name, "OpenRouter");
                assert_eq!(config.model, clipy_local_moments::DEFAULT_OPENROUTER_MODEL);
                assert_eq!(config.api_key.as_deref(), Some("k"));
            }
            other => panic!("{other:?}"),
        }
        s.model = StoredModel {
            preset: ModelPreset::Ollama,
            model: Some("llama3".into()),
            base_url: None,
        };
        match moment_provider(&s, &KeyFile::default()) {
            MomentProvider::Ready { config, recipient } => {
                assert_eq!(recipient.host, "127.0.0.1");
                assert!(config.api_key.is_none());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn transcription_plan_names_the_recipient() {
        let mut s = windows();
        assert_eq!(
            transcription_plan(&s),
            TranscriptionPlan::Local(LocalModelId::EnglishFast)
        );
        s.transcription.kind = TranscriptionKind::Deepgram;
        s.transcription.local_model = None;
        assert_eq!(
            transcription_plan(&s),
            TranscriptionPlan::Provider {
                kind: TranscriptionKind::Deepgram,
                recipient: Recipient {
                    name: "Deepgram".into(),
                    host: "api.deepgram.com".into()
                }
            }
        );
        s.transcription.kind = TranscriptionKind::None;
        assert_eq!(transcription_plan(&s), TranscriptionPlan::Off);
        assert_eq!(
            transcription_plan(&StoredSettings::defaults(Platform::Mac)),
            TranscriptionPlan::Apple
        );
    }

    #[test]
    fn progress_reports_bytes_and_the_verifying_stage() {
        let p = LocalModelProgressDto::running(LocalModelId::EnglishFast, 0.425);
        assert_eq!(p.stage, ProgressStage::Downloading);
        assert_eq!(p.total_bytes, 104_337_827);
        assert_eq!(p.received_bytes, 52_168_914);
        let p = LocalModelProgressDto::running(LocalModelId::EnglishFast, 0.9);
        assert_eq!(p.stage, ProgressStage::Verifying);
        assert_eq!(p.received_bytes, p.total_bytes);
        let p = LocalModelProgressDto::running(LocalModelId::Multilingual, 0.5);
        assert_eq!(p.stage, ProgressStage::Downloading);
        let p = LocalModelProgressDto::running(LocalModelId::Multilingual, f64::NAN);
        assert_eq!(p.received_bytes, 0);
        assert_eq!(
            serde_json::to_value(LocalModelProgressDto::failed(
                LocalModelId::Multilingual,
                "no"
            ))
            .unwrap(),
            json!({"model":"multilingual","stage":"failed","receivedBytes":0,"totalBytes":160_609_290u64,"error":"no"})
        );
        assert_eq!(
            serde_json::to_value(LocalModelStatusDto::new(
                LocalModelId::EnglishFast,
                true,
                false
            ))
            .unwrap(),
            json!({"id":"english-fast","label":"English, fast (Parakeet TDT-CTC 110M)","sizeBytes":104_337_827u64,"installed":true,"downloading":false})
        );
    }

    #[cfg(feature = "stt")]
    #[test]
    fn model_rows_match_the_crate() {
        for id in LocalModelId::ALL {
            let spec = id.to_stt().spec();
            assert_eq!(spec.id, id.id());
            assert_eq!(spec.label, id.label());
            assert_eq!(spec.size_bytes, id.size_bytes());
            let has_archive = spec.files.iter().any(|f| f.archive.is_some());
            assert_eq!(has_archive, id.download_share() < 1.0);
        }
    }

    #[cfg(feature = "stt")]
    #[test]
    fn stt_hosts_match_the_crate() {
        use clipy_local_stt::providers::*;
        let host = |u: &str| url_host(u).unwrap();
        assert_eq!(
            TranscriptionKind::OpenAi.provider_host().unwrap(),
            host(OPENAI_BASE_URL)
        );
        assert_eq!(
            TranscriptionKind::Groq.provider_host().unwrap(),
            host(GROQ_BASE_URL)
        );
        assert_eq!(
            TranscriptionKind::Deepgram.provider_host().unwrap(),
            host(DEEPGRAM_BASE_URL)
        );
        assert_eq!(
            TranscriptionKind::AssemblyAi.provider_host().unwrap(),
            host(ASSEMBLYAI_BASE_URL)
        );
        assert_eq!(
            TranscriptionKind::ElevenLabs.provider_host().unwrap(),
            host(ELEVENLABS_BASE_URL)
        );
        assert_eq!(
            TranscriptionKind::Gemini.provider_host().unwrap(),
            host(GEMINI_BASE_URL)
        );
    }

    #[cfg(feature = "stt")]
    #[test]
    fn stt_config_maps_every_provider() {
        use clipy_local_stt::ProviderConfig as Stt;
        assert!(stt_config(TranscriptionKind::Deepgram, None, None)
            .unwrap_err()
            .contains("Deepgram needs an API key"));
        assert!(stt_config(TranscriptionKind::Local, None, Some("k")).is_err());
        match stt_config(TranscriptionKind::Groq, None, Some("k")).unwrap() {
            Stt::OpenAiCompatible {
                base_url,
                model,
                api_key,
            } => {
                assert_eq!(base_url, clipy_local_stt::providers::GROQ_BASE_URL);
                assert_eq!(model, clipy_local_stt::providers::GROQ_DEFAULT_MODEL);
                assert_eq!(api_key, "k");
            }
            other => panic!("{other:?}"),
        }
        match stt_config(
            TranscriptionKind::OpenAi,
            Some("gpt-4o-transcribe"),
            Some("k"),
        )
        .unwrap()
        {
            Stt::OpenAiCompatible { model, .. } => assert_eq!(model, "gpt-4o-transcribe"),
            other => panic!("{other:?}"),
        }
        for kind in [
            TranscriptionKind::Deepgram,
            TranscriptionKind::AssemblyAi,
            TranscriptionKind::ElevenLabs,
            TranscriptionKind::Gemini,
        ] {
            let config = stt_config(kind, None, Some("SECRET")).unwrap();
            assert_eq!(config.kind(), kind.id());
            assert!(!format!("{config:?}").contains("SECRET"));
        }
    }
}
