export interface UpdateSettings {
  serverUrl: string;
  automaticEnabled: boolean;
}

export interface UpdateSettingsResult {
  ok: boolean;
  settings: UpdateSettings;
  error?: string;
}
