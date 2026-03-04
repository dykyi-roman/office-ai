// Sound system — Web Audio API synthesis for agent events

export { SoundEngine } from "./SoundEngine";
export { initSoundBridge, destroySoundBridge } from "./SoundEventBridge";
export {
  SOUND_DEFINITIONS,
  STATUS_SOUND_MAP,
  type SoundEvent,
  type SoundDefinition,
  type OscillatorNote,
  type WaveformType,
} from "./SoundDefinitions";
