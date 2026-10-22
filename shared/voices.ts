/**
 * Vozes predefinidas da Runway (modelos ElevenLabs servidos pela Runway).
 * Lista retirada dos tipos do SDK oficial @runwayml/sdk 4.22 (TextToSpeech, presetId).
 * O idioma é imposto com languageCode (ex.: "pt"); a qualidade em português
 * varia por voz — ouça a prévia antes de associar ao personagem.
 */
export const RUNWAY_VOICE_PRESETS = [
  'Maya', 'Arjun', 'Serene', 'Bernard', 'Billy', 'Mark', 'Clint', 'Mabel', 'Chad', 'Leslie', 'Eleanor', 'Elias',
  'Elliot', 'Grungle', 'Brodie', 'Sandra', 'Kirk', 'Kylie', 'Lara', 'Lisa', 'Malachi', 'Marlene', 'Martin',
  'Miriam', 'Monster', 'Paula', 'Pip', 'Rusty', 'Ragnar', 'Xylar', 'Maggie', 'Jack', 'Katie', 'Noah', 'James',
  'Rina', 'Ella', 'Mariah', 'Frank', 'Claudia', 'Niki', 'Vincent', 'Kendrick', 'Myrna', 'Tom', 'Wanda',
  'Benjamin', 'Kiana', 'Rachel',
] as const;
export type RunwayVoicePreset = (typeof RUNWAY_VOICE_PRESETS)[number];

export const TTS_LANGUAGES = [
  { code: 'pt', label: 'Português (Brasil)' },
  { code: 'en', label: 'Inglês' },
  { code: 'es', label: 'Espanhol' },
] as const;

export function isVoicePreset(v: string): v is RunwayVoicePreset {
  return (RUNWAY_VOICE_PRESETS as readonly string[]).includes(v);
}
