export interface IntegrationState {
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
}

export interface Capabilities {
  worker_online: boolean;
  integrations: Record<string, IntegrationState>;
  /** o que o motor próprio dos workers online oferece */
  local?: { transcribe: boolean; tts: boolean; voices: string[] };
}
