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

/** Nome amigável para vozes do Piper (ex.: "pt_BR-faber-medium" → "Faber (pt-BR, média)"). */
export function piperVoiceLabel(id: string): string {
  const m = id.match(/^([a-z]{2})_([A-Z]{2})-([^-]+)-(x_low|low|medium|high)$/);
  if (!m) return id;
  const quality = { x_low: 'muito leve', low: 'leve', medium: 'média', high: 'alta' }[m[4]];
  return `${m[3].charAt(0).toUpperCase()}${m[3].slice(1)} (${m[1]}-${m[2]}, ${quality})`;
}
