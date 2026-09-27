import {
  App,
  Modal,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from 'obsidian';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface WhisperMcpSettings {
  endpoint: string;
  apiToken: string;
  model: 'small' | 'medium';
  language: string;
  pollSeconds: number;
  timeoutSeconds: number;
  audioDirectory: string;
  autoTranscribe: boolean;
  autoTranscribeDelaySeconds: number;
  clippingDirectory: string;
}

const DEFAULT_SETTINGS: WhisperMcpSettings = {
  endpoint: 'http://localhost:8000/mcp/',
  apiToken: '',
  model: 'small',
  language: 'auto',
  pollSeconds: 2,
  timeoutSeconds: 300,
  audioDirectory: 'Audio',
  autoTranscribe: false,
  autoTranscribeDelaySeconds: 30,
  clippingDirectory: 'Clippings',
};

const PROCESSED_AUDIO_FILE = 'processed-audio.json';

interface ToolResultLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

function extractToolResult(result: ToolResultLike): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === 'text' && item.text) {
        try {
          return JSON.parse(item.text);
        } catch {
          return { text: item.text };
        }
      }
    }
  }

  return result;
}

function getAudioMimeType(file: TFile): string {
  switch (file.extension.toLowerCase()) {
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'flac':
      return 'audio/flac';
    default:
      return 'application/octet-stream';
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function normalizeEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) return value;
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Obsidian runs plugins inside an app:// WebView. Using the normal fetch()
 * path makes the MCP server see Origin: app://obsidian.md and its Origin
 * protection can reject the request. Obsidian's requestUrl() performs the
 * HTTP request outside the WebView and explicitly bypasses CORS restrictions.
 *
 * The MCP SDK accepts a custom fetch implementation, so we adapt requestUrl()
 * to the standard Fetch API Response expected by StreamableHTTPClientTransport.
 */
async function obsidianFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let body: string | ArrayBuffer | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    body = await request.text();
  }

  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers,
    body,
    throw: false,
  });

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(key, String(item));
    } else if (value !== undefined) {
      responseHeaders.set(key, String(value));
    }
  }

  return new Response(response.text ?? '', {
    status: response.status,
    headers: responseHeaders,
  });
}

class WhisperMcpClient {
  constructor(private readonly settings: WhisperMcpSettings) {}

  private async connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const headers: Record<string, string> = {};
    if (this.settings.apiToken.trim()) {
      headers.Authorization = `Bearer ${this.settings.apiToken.trim()}`;
    }

    const endpoint = normalizeEndpoint(this.settings.endpoint);
    const transport = new StreamableHTTPClientTransport(
      new URL(endpoint),
      {
        fetch: obsidianFetch,
        ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
      },
    );

    const client = new Client({ name: 'obsidian-whisper-mcp', version: '0.1.0' });
    await client.connect(transport);
    return { client, transport };
  }

  async listToolNames(): Promise<string[]> {
    const { client } = await this.connect();
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => tool.name);
    } finally {
      await client.close();
    }
  }

  async transcribe(file: TFile, app: App, onStatus: (message: string) => void): Promise<string> {
    const { client, transport } = await this.connect();

    try {
      onStatus('Connexion MCP établie');

      const tools = await client.listTools();
      const required = ['transcribe_data', 'get_transcription_status', 'get_transcription_result'];
      const names = new Set(tools.tools.map((tool) => tool.name));
      const missing = required.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new Error(`Outils MCP manquants : ${missing.join(', ')}`);
      }

      onStatus(`Lecture de ${file.name}`);
      const data = await app.vault.readBinary(file);
      const encoded = arrayBufferToBase64(data);
      const contentType = getAudioMimeType(file);

      onStatus(`Envoi de ${file.name} (${data.byteLength} octets)`);
      const submit = await client.callTool({
        name: 'transcribe_data',
        arguments: {
          data_base64: encoded,
          filename: file.name,
          content_type: contentType,
          model: this.settings.model,
          language: this.settings.language,
          debug: false,
          api_token: this.settings.apiToken || undefined,
        },
      }) as ToolResultLike;

      if (submit.isError) throw new Error(`transcribe_data a retourné une erreur : ${JSON.stringify(submit)}`);

      const submitResult = extractToolResult(submit);
      if (!submitResult || typeof submitResult !== 'object') {
        throw new Error(`Réponse inattendue de transcribe_data : ${String(submitResult)}`);
      }

      const jobId = (submitResult as Record<string, unknown>).id;
      if (typeof jobId !== 'string' || !jobId) {
        throw new Error(`Aucun id de job dans la réponse MCP : ${JSON.stringify(submitResult)}`);
      }

      onStatus(`Job ${jobId} lancé`);
      const started = Date.now();

      while (true) {
        if ((Date.now() - started) / 1000 > this.settings.timeoutSeconds) {
          throw new Error(`Timeout en attente du job ${jobId}`);
        }

        await new Promise((resolve) => window.setTimeout(resolve, this.settings.pollSeconds * 1000));

        const statusResponse = await client.callTool({
          name: 'get_transcription_status',
          arguments: {
            job_id: jobId,
            api_token: this.settings.apiToken || undefined,
          },
        }) as ToolResultLike;

        if (statusResponse.isError) {
          throw new Error(`get_transcription_status a retourné une erreur : ${JSON.stringify(statusResponse)}`);
        }

        const status = extractToolResult(statusResponse);
        if (!status || typeof status !== 'object') continue;

        const state = (status as Record<string, unknown>).status;
        onStatus(`Job ${jobId} : ${String(state ?? 'inconnu')}`);

        if (state === 'completed') break;
        if (state === 'failed') {
          throw new Error(`Transcription échouée : ${String((status as Record<string, unknown>).error ?? 'erreur inconnue')}`);
        }
      }

      onStatus('Récupération du résultat');
      const finalResponse = await client.callTool({
        name: 'get_transcription_result',
        arguments: {
          job_id: jobId,
          api_token: this.settings.apiToken || undefined,
        },
      }) as ToolResultLike;

      if (finalResponse.isError) {
        throw new Error(`get_transcription_result a retourné une erreur : ${JSON.stringify(finalResponse)}`);
      }

      const resultData = extractToolResult(finalResponse);
      if (!resultData || typeof resultData !== 'object') {
        throw new Error(`Réponse finale inattendue : ${String(resultData)}`);
      }

      const nested = (resultData as Record<string, unknown>).result;
      if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).text === 'string') {
        return nested.text as string;
      }

      if (typeof (resultData as Record<string, unknown>).text === 'string') {
        return (resultData as Record<string, unknown>).text as string;
      }

      throw new Error(`Le résultat MCP ne contient pas de champ text : ${JSON.stringify(resultData)}`);
    } finally {
      try {
        await transport.terminateSession();
      } catch {
        // Best effort: certains serveurs MCP ne fournissent pas de session à terminer.
      }
      await client.close();
    }
  }
}

type AudioSortKey = 'name' | 'size' | 'ctime' | 'mtime';

type AudioSortDirection = 'asc' | 'desc';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

function formatFileDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function normalizeVaultPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

const AUDIO_EXTENSIONS = new Set(['m4a', 'mp4', 'mp3', 'wav', 'ogg', 'opus', 'webm', 'flac']);

function isAudioFile(file: TFile): boolean {
  return AUDIO_EXTENSIONS.has(file.extension.toLowerCase());
}

function audioFilesSnapshot(app: App): Set<string> {
  return new Set(app.vault.getFiles().filter(isAudioFile).map((file) => file.path));
}

function findNewAudioFiles(app: App, before: Set<string>): TFile[] {
  return app.vault.getFiles()
    .filter(isAudioFile)
    .filter((file) => !before.has(file.path))
    .sort((a, b) => b.stat.ctime - a.stat.ctime);
}

function isInDirectory(filePath: string, directory: string): boolean {
  const normalizedDirectory = normalizeVaultPath(directory);
  if (!normalizedDirectory) return true;
  return filePath === normalizedDirectory || filePath.startsWith(`${normalizedDirectory}/`);
}

function formatDatePrefix(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function sanitizeNoteBasename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#\[\]]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'Transcription';
}

function markdownAudioLink(file: TFile, note: TFile): string {
  const noteParts = note.path.split('/').slice(0, -1);
  const fileParts = file.path.split('/');
  let common = 0;
  while (common < noteParts.length && common < fileParts.length && noteParts[common] === fileParts[common]) {
    common++;
  }

  const relativeParts = [
    ...noteParts.slice(common).map(() => '..'),
    ...fileParts.slice(common),
  ];
  const href = relativeParts.map(encodeURIComponent).join('/');
  const label = file.name.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  return `[🎧 ${label}](${href})`;
}

class AudioFileModal extends Modal {
  private selected: TFile | null = null;
  private filteredFiles: TFile[];
  private sortKey: AudioSortKey = 'mtime';
  private sortDirection: AudioSortDirection = 'desc';
  private searchTerm = '';
  private tableBodyEl!: HTMLTableSectionElement;
  private countEl!: HTMLElement;
  private searchEl!: HTMLInputElement;

  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly audioDirectory: string,
    private readonly onSelect: (file: TFile) => void,
  ) {
    super(app);
    this.filteredFiles = [...files];
  }

  private compare(a: TFile, b: TFile): number {
    let result = 0;
    switch (this.sortKey) {
      case 'name':
        result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'size':
        result = a.stat.size - b.stat.size;
        break;
      case 'ctime':
        result = a.stat.ctime - b.stat.ctime;
        break;
      case 'mtime':
        result = a.stat.mtime - b.stat.mtime;
        break;
    }
    return this.sortDirection === 'asc' ? result : -result;
  }

  private refresh(): void {
    const term = this.searchTerm.trim().toLowerCase();
    this.filteredFiles = this.files
      .filter((file) => !term || file.path.toLowerCase().includes(term))
      .sort((a, b) => this.compare(a, b));

    this.countEl.setText(`${this.filteredFiles.length} fichier(s)`);
    this.tableBodyEl.empty();

    for (const file of this.filteredFiles) {
      const row = this.tableBodyEl.createEl('tr');
      row.style.cursor = 'pointer';
      if (this.selected?.path === file.path) row.addClass('is-selected');

      const nameCell = row.createEl('td');
      nameCell.createEl('strong', { text: file.name });
      const pathEl = nameCell.createEl('div', { text: file.path });
      pathEl.style.opacity = '0.65';
      pathEl.style.fontSize = '0.85em';

      row.createEl('td', { text: formatFileSize(file.stat.size) });
      row.createEl('td', { text: formatFileDate(file.stat.ctime) });
      row.createEl('td', { text: formatFileDate(file.stat.mtime) });

      row.addEventListener('click', () => {
        this.selected = file;
        this.refresh();
      });
      row.addEventListener('dblclick', () => {
        this.selected = file;
        this.confirmSelection();
      });
    }
  }

  private confirmSelection(): void {
    if (!this.selected) return;
    const file = this.selected;
    this.close();
    this.onSelect(file);
  }

  private setSort(key: AudioSortKey): void {
    if (this.sortKey === key) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDirection = key === 'name' ? 'asc' : 'desc';
    }
    this.refresh();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Whisper MCP — choisir un fichier audio' });
    contentEl.createEl('div', { text: `Répertoire : ${this.audioDirectory || '/'}` }).style.opacity = '0.7';

    this.searchEl = contentEl.createEl('input', {
      type: 'search',
      placeholder: 'Rechercher un fichier…',
    });
    this.searchEl.style.width = '100%';
    this.searchEl.style.margin = '1em 0 0.5em';
    this.searchEl.addEventListener('input', () => {
      this.searchTerm = this.searchEl.value;
      this.refresh();
    });

    const toolbar = contentEl.createDiv();
    toolbar.style.display = 'flex';
    toolbar.style.justifyContent = 'space-between';
    toolbar.style.alignItems = 'center';
    toolbar.style.marginBottom = '0.5em';
    this.countEl = toolbar.createEl('span');

    const hint = toolbar.createEl('span', { text: 'Cliquez sur une colonne pour trier · double-clic pour transcrire' });
    hint.style.opacity = '0.65';
    hint.style.fontSize = '0.85em';

    const table = contentEl.createEl('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '0.9em';

    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    const headers: Array<[string, AudioSortKey]> = [
      ['Fichier', 'name'],
      ['Taille', 'size'],
      ['Création', 'ctime'],
      ['Modification', 'mtime'],
    ];
    for (const [label, key] of headers) {
      const th = headerRow.createEl('th', { text: label });
      th.style.textAlign = 'left';
      th.style.padding = '0.45em';
      th.style.cursor = 'pointer';
      th.title = 'Cliquer pour trier';
      th.addEventListener('click', () => this.setSort(key));
    }

    this.tableBodyEl = table.createEl('tbody');

    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.justifyContent = 'flex-end';
    footer.style.gap = '0.5em';
    footer.style.marginTop = '1em';

    const cancel = footer.createEl('button', { text: 'Annuler' });
    cancel.addEventListener('click', () => this.close());

    const button = footer.createEl('button', { text: 'Transcrire' });
    button.addClass('mod-cta');
    button.addEventListener('click', () => this.confirmSelection());

    this.refresh();

    this.scope.register([], 'Enter', (event) => {
      event.preventDefault();
      this.confirmSelection();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ResultModal extends Modal {
  constructor(app: App, private readonly text: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Transcription Whisper' });
    const pre = contentEl.createEl('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.maxHeight = '70vh';
    pre.style.overflow = 'auto';
    pre.setText(this.text);

    const close = contentEl.createEl('button', { text: 'Fermer' });
    close.style.marginTop = '1em';
    close.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class WhisperSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WhisperMcpPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Whisper MCP' });

    new Setting(containerEl)
      .setName('Endpoint MCP')
      .setDesc('Endpoint Streamable HTTP de ton serveur MCP, par exemple http://192.168.1.10:8000/mcp')
      .addText((text) => text
        .setPlaceholder('http://localhost:8000/mcp')
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (value) => {
          this.plugin.settings.endpoint = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API token')
      .setDesc('Token Bearer utilisé par le transport MCP et transmis aux outils Whisper.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(this.plugin.settings.apiToken);
        text.onChange(async (value) => {
          this.plugin.settings.apiToken = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Modèle')
      .addDropdown((dropdown) => dropdown
        .addOption('small', 'small')
        .addOption('medium', 'medium')
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value as 'small' | 'medium';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Langue')
      .setDesc('auto, fr, en, etc.')
      .addText((text) => text
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = value.trim() || 'auto';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Intervalle de polling')
      .setDesc('Secondes entre deux appels get_transcription_status.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.pollSeconds))
        .onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0.5) {
            this.plugin.settings.pollSeconds = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Timeout')
      .setDesc('Durée maximale d’une transcription, en secondes.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.timeoutSeconds))
        .onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 10) {
            this.plugin.settings.timeoutSeconds = n;
            await this.plugin.saveSettings();
          }
        }));

    containerEl.createEl('h3', { text: 'Fichiers audio' });

    new Setting(containerEl)
      .setName('Répertoire audio')
      .setDesc('Chemin du répertoire contenant les fichiers audio, relatif à la racine du vault. Par défaut : Audio')
      .addText((text) => text
        .setPlaceholder('Audio')
        .setValue(this.plugin.settings.audioDirectory)
        .onChange(async (value) => {
          this.plugin.settings.audioDirectory = normalizeVaultPath(value) || 'Audio';
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Transcription automatique' });

    new Setting(containerEl)
      .setName('Transcription automatique des nouveaux enregistrements')
      .setDesc('Lorsqu’un nouveau fichier audio apparaît dans le répertoire audio, lance automatiquement sa transcription et crée une note dans le répertoire des Clippings.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoTranscribe)
        .onChange(async (value) => {
          this.plugin.settings.autoTranscribe = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Délai avant transcription automatique')
      .setDesc('Délai minimal après la détection d’un nouvel enregistrement. Le plugin vérifie ensuite que le fichier est stable avant de lancer Whisper. Par défaut : 30 secondes.')
      .addText((text) => text
        .setPlaceholder('30')
        .setValue(String(this.plugin.settings.autoTranscribeDelaySeconds))
        .setSuffix('s')
        .onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.autoTranscribeDelaySeconds = Math.round(n);
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Répertoire des notes (Clippings)')
      .setDesc('Répertoire de destination des notes créées automatiquement, relatif à la racine du vault. Il est créé automatiquement s’il n’existe pas. Par défaut : Clippings')
      .addText((text) => text
        .setPlaceholder('Clippings')
        .setValue(this.plugin.settings.clippingDirectory)
        .onChange(async (value) => {
          this.plugin.settings.clippingDirectory = normalizeVaultPath(value) || 'Clippings';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Tester la connexion MCP')
      .setDesc('Effectue initialize puis tools/list.')
      .addButton((button) => button
        .setButtonText('Tester')
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const client = new WhisperMcpClient(this.plugin.settings);
            const tools = await client.listToolNames();
            new Notice(`MCP OK — ${tools.length} outil(s) : ${tools.join(', ')}`);
          } catch (error) {
            new Notice(`MCP erreur : ${error instanceof Error ? error.message : String(error)}`, 10000);
          } finally {
            button.setDisabled(false);
          }
        }));
  }
}

export default class WhisperMcpPlugin extends Plugin {
  settings: WhisperMcpSettings = DEFAULT_SETTINGS;
  private readonly automaticQueue: TFile[] = [];
  private readonly automaticQueuedPaths = new Set<string>();
  private automaticQueueRunning = false;
  private knownAudioPaths = new Set<string>();
  private processedAudioPaths = new Set<string>();
  private processedAudioSavePromise: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    await this.loadSettings();

    console.log(`Whisper MCP v${this.manifest.version} — chargement du plugin`);
    new Notice(`Whisper MCP v${this.manifest.version} chargé`, 3000);

    // Load processing history before taking the startup snapshot and before
    // registering the create listener.
    await this.loadProcessedAudioPaths();

    // Files already present at plugin startup must never be treated as new recordings.
    this.knownAudioPaths = audioFilesSnapshot(this.app);

    this.addCommand({
      id: 'record-and-transcribe',
      name: 'Enregistrer et transcrire',
      callback: () => void this.recordAndTranscribe(),
    });

    this.addCommand({
      id: 'transcribe-audio-file',
      name: 'Transcrire un fichier audio',
      callback: () => this.chooseAndTranscribe(false),
    });

    this.addCommand({
      id: 'transcribe-and-insert-active-note',
      name: 'Transcrire et insérer dans la note active',
      callback: () => this.chooseAndTranscribe(true),
    });

    this.addSettingTab(new WhisperSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on('create', (abstractFile) => {
      if (!(abstractFile instanceof TFile)) return;
      if (!isAudioFile(abstractFile)) return;
      if (!isInDirectory(abstractFile.path, this.settings.audioDirectory)) return;

      // Ignore files that existed when the plugin was loaded.
      if (this.knownAudioPaths.has(abstractFile.path)) return;
      this.knownAudioPaths.add(abstractFile.path);

      if (!this.settings.autoTranscribe) return;
      if (this.processedAudioPaths.has(abstractFile.path)) return;
      this.enqueueAutomaticTranscription(abstractFile);
    }));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    // data.json contains settings only. Processing history is stored separately.
    await this.saveData({ ...this.settings });
  }

  private async loadProcessedAudioPaths(): Promise<void> {
    const adapter = this.app.vault.adapter;

    try {
      if (await adapter.exists(PROCESSED_AUDIO_FILE)) {
        const raw = await adapter.read(PROCESSED_AUDIO_FILE);
        const parsed = JSON.parse(raw) as unknown;
        const paths = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as { processedAudioPaths?: unknown }).processedAudioPaths)
            ? (parsed as { processedAudioPaths: unknown[] }).processedAudioPaths
            : parsed && typeof parsed === 'object' && Array.isArray((parsed as { paths?: unknown }).paths)
              ? (parsed as { paths: unknown[] }).paths
              : [];

        this.processedAudioPaths = new Set(
          paths.filter((value): value is string => typeof value === 'string'),
        );
        console.log(`Whisper MCP: historique chargé (${this.processedAudioPaths.size} fichier(s))`);
        return;
      }
    } catch (error) {
      console.warn('Whisper MCP: impossible de lire processed-audio.json', error);
    }

    // Migration from versions that stored the history in data.json.
    const legacyData = await this.loadData() as { whisperProcessedAudioPaths?: unknown };
    if (Array.isArray(legacyData.whisperProcessedAudioPaths)) {
      this.processedAudioPaths = new Set(
        legacyData.whisperProcessedAudioPaths
          .filter((value): value is string => typeof value === 'string'),
      );
      await this.saveProcessedAudioPaths();
      await this.saveSettings();
      return;
    }

    // First run: create an empty history file immediately.
    await this.saveProcessedAudioPaths();
  }

  private async saveProcessedAudioPaths(): Promise<void> {
    this.processedAudioSavePromise = this.processedAudioSavePromise.then(async () => {
      const content = JSON.stringify({
        version: 1,
        processedAudioPaths: [...this.processedAudioPaths].sort(),
      }, null, 2) + '\n';

      await this.app.vault.adapter.write(PROCESSED_AUDIO_FILE, content);

      if (!(await this.app.vault.adapter.exists(PROCESSED_AUDIO_FILE))) {
        throw new Error(`Impossible de créer ${PROCESSED_AUDIO_FILE} à la racine du vault`);
      }

      console.log(`Whisper MCP: ${PROCESSED_AUDIO_FILE} sauvegardé (${this.processedAudioPaths.size} fichier(s))`);
    });

    return this.processedAudioSavePromise;
  }

  private getAudioFiles(): TFile[] {
    return this.app.vault.getFiles()
      .filter((file) => isAudioFile(file))
      .filter((file) => isInDirectory(file.path, this.settings.audioDirectory))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (!normalized) return;

    const parts = normalized.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async createAutomaticTranscriptionNote(audioFile: TFile, text: string): Promise<TFile> {
    const clippingDirectory = normalizeVaultPath(this.settings.clippingDirectory) || 'Clippings';
    await this.ensureFolder(clippingDirectory);

    const prefix = formatDatePrefix(audioFile.stat.ctime || audioFile.stat.mtime);
    const base = sanitizeNoteBasename(audioFile.basename);
    let notePath = `${clippingDirectory}/${prefix}_${base}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(notePath)) {
      notePath = `${clippingDirectory}/${prefix}_${base}_${suffix}.md`;
      suffix += 1;
    }

    const sourceLink = markdownAudioLink(audioFile, {
      path: notePath,
    } as TFile);
    const content = `# ${audioFile.basename}\n\n> **Fichier audio :** ${sourceLink}\n> **Date de création :** ${formatFileDate(audioFile.stat.ctime)}\n> **Date de modification :** ${formatFileDate(audioFile.stat.mtime)}\n> **Modèle :** ${this.settings.model}\n> **Langue :** ${this.settings.language}\n\n${text.trim()}\n`;

    return this.app.vault.create(notePath, content);
  }

  private async waitForFileStable(filePath: string, notice: Notice): Promise<TFile | null> {
    const initialDelaySeconds = Math.max(0, this.settings.autoTranscribeDelaySeconds);
    if (initialDelaySeconds > 0) {
      notice.setMessage(`Whisper automatique : attente ${initialDelaySeconds}s avant vérification de ${filePath.split('/').pop()}`);
      await new Promise((resolve) => window.setTimeout(resolve, initialDelaySeconds * 1000));
    }

    let previousSize = -1;
    let previousMtime = -1;
    let stableChecks = 0;

    while (true) {
      const current = this.app.vault.getAbstractFileByPath(filePath);
      if (!(current instanceof TFile)) return null;

      const size = current.stat.size;
      const mtime = current.stat.mtime;
      if (size === previousSize && mtime === previousMtime) {
        stableChecks += 1;
      } else {
        stableChecks = 0;
        previousSize = size;
        previousMtime = mtime;
      }

      if (stableChecks >= 1) return current;

      notice.setMessage(`Whisper automatique : ${current.name} est encore en cours d’écriture…`);
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
    }
  }

  private enqueueAutomaticTranscription(file: TFile): void {
    if (this.automaticQueuedPaths.has(file.path)) return;

    this.automaticQueuedPaths.add(file.path);
    this.automaticQueue.push(file);

    const position = this.automaticQueue.length;
    new Notice(`Whisper automatique : ${file.name} ajouté à la file${position > 1 ? ` (position ${position})` : ''}.`, 5000);
    void this.processAutomaticQueue();
  }

  private async processAutomaticQueue(): Promise<void> {
    if (this.automaticQueueRunning) return;
    this.automaticQueueRunning = true;

    try {
      while (this.automaticQueue.length > 0) {
        const file = this.automaticQueue.shift();
        if (!file) continue;
        this.automaticQueuedPaths.delete(file.path);

        const current = this.app.vault.getAbstractFileByPath(file.path);
        if (!(current instanceof TFile) || !isAudioFile(current)) {
          continue;
        }

        const notice = new Notice(`Whisper automatique : attente avant ${current.name}`, 0);
        try {
          // Un seul fichier est traité à la fois. On attend d'abord le délai
          // configuré, puis on vérifie que la taille/date du fichier sont stables
          // avant de lancer Whisper. Cela évite de transcrire un enregistrement
          // encore en cours d'écriture.
          const latest = await this.waitForFileStable(current.path, notice);
          if (!latest) {
            notice.hide();
            continue;
          }

          notice.setMessage(`Whisper automatique : transcription de ${latest.name}`);
          const client = new WhisperMcpClient(this.settings);
          const text = await client.transcribe(latest, this.app, (message) => {
            notice.setMessage(`Whisper automatique : ${message}`);
          });

          const note = await this.createAutomaticTranscriptionNote(latest, text);
          this.processedAudioPaths.add(latest.path);
          await this.saveProcessedAudioPaths();
          notice.hide();
          new Notice(`Transcription automatique créée : ${note.path}`, 7000);
        } catch (error) {
          notice.hide();
          const message = error instanceof Error ? error.message : String(error);
          console.error('Whisper MCP automatic transcription error', error);
          new Notice(`Whisper automatique : ${message}`, 15000);
        }
      }
    } finally {
      this.automaticQueueRunning = false;
      // Sécurité : si un événement est arrivé juste au moment où la boucle se terminait.
      if (this.automaticQueue.length > 0) {
        void this.processAutomaticQueue();
      }
    }
  }

  private async recordAndTranscribe(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') {
      new Notice('Ouvre d’abord une note Markdown active.');
      return;
    }

    const recorder = (this.app as any).internalPlugins?.plugins?.['audio-recorder']?.instance;
    if (!recorder) {
      new Notice('Le module natif « Audio recorder » d’Obsidian n’est pas activé.');
      return;
    }

    const commandId = 'audio-recorder:start';
    const commands = (this.app as any).commands;
    if (!commands?.executeCommandById) {
      new Notice('Impossible de piloter le module Audio recorder d’Obsidian.');
      return;
    }

    if (recorder.recording) {
      new Notice('Un enregistrement est déjà en cours. Arrête-le avec le bouton Audio recorder, puis relance « Enregistrer et transcrire ».');
      return;
    }

    const beforeFiles = audioFilesSnapshot(this.app);
    const beforeNote = await this.app.vault.read(activeFile);

    const started = commands.executeCommandById(commandId);
    if (!started) {
      new Notice('Impossible de démarrer l’enregistrement Audio recorder. Vérifie que le module natif est activé.');
      return;
    }

    const notice = new Notice('🎙️ Enregistrement en cours… Arrête l’enregistrement avec le bouton Audio recorder.', 0);

    try {
      // Le démarrage du core plugin peut être légèrement asynchrone. On attend
      // d’abord que son état passe réellement à recording=true.
      let recordingStarted = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (recorder.recording) {
          recordingStarted = true;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      if (!recordingStarted) {
        throw new Error('Le module Audio recorder n’a pas démarré l’enregistrement.');
      }

      // Le plugin ne remplace pas le bouton Stop d’Obsidian : l’utilisateur
      // arrête l’enregistrement avec le module natif. Nous attendons ensuite
      // que le fichier soit créé et que le lien soit ajouté à la note active.
      while (recorder.recording) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }

      notice.setMessage('🎙️ Enregistrement terminé. Recherche du fichier audio…');

      let audioFile: TFile | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        const currentActive = this.app.vault.getAbstractFileByPath(activeFile.path);
        if (!(currentActive instanceof TFile)) break;

        const newFiles = findNewAudioFiles(this.app, beforeFiles);
        const noteContent = await this.app.vault.read(currentActive);

        // Priorité au fichier effectivement ajouté dans la note.
        const candidate = newFiles.find((file) => {
          return noteContent.includes(file.name) && !beforeNote.includes(file.name);
        });

        audioFile = candidate ?? newFiles[0] ?? null;
        if (audioFile) break;

        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }

      if (!audioFile) {
        throw new Error('Aucun nouvel enregistrement audio n’a été trouvé dans le vault.');
      }

      notice.setMessage(`🎙️ ${audioFile.name} détecté. Attente du fichier stable…`);
      const stable = await this.waitForFileStable(audioFile.path, notice);
      if (!stable) throw new Error(`Le fichier ${audioFile.name} n’est plus disponible.`);

      notice.setMessage(`Whisper : transcription de ${stable.name}`);
      const client = new WhisperMcpClient(this.settings);
      const text = await client.transcribe(stable, this.app, (message) => {
        notice.setMessage(`Whisper : ${message}`);
      });

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.file || view.file.path !== activeFile.path) {
        throw new Error('La note active n’est plus disponible pour l’insertion.');
      }

      const editor = view.editor;
      const content = editor.getValue();
      const lines = content.split('\n');
      const audioLineIndex = lines.findIndex((line) => line.includes(stable.name));

      const metadata = `> **Fichier audio :** ${markdownAudioLink(stable, activeFile)}\n> **Modèle :** ${this.settings.model}\n> **Langue :** ${this.settings.language}\n`;
      const block = `\n\n## Transcription Whisper\n\n${metadata}\n${text.trim()}\n`;

      if (audioLineIndex >= 0) {
        const line = lines[audioLineIndex];
        editor.replaceRange(block, { line: audioLineIndex, ch: line.length });
      } else {
        const lastLine = Math.max(0, editor.lineCount() - 1);
        editor.replaceRange(`\n${block}`, { line: lastLine, ch: editor.getLine(lastLine).length });
      }

      // Mark as processed only after transcription and insertion succeeded.
      this.processedAudioPaths.add(stable.path);
      await this.saveProcessedAudioPaths();
      notice.hide();
      new Notice(`🎙️ Transcription insérée dans « ${activeFile.basename} »`, 7000);
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      console.error('Whisper MCP record-and-transcribe error', error);
      new Notice(`Enregistrer et transcrire : ${message}`, 15000);
    }
  }

  private async chooseAndTranscribe(insertIntoActiveNote: boolean): Promise<void> {
    const files = this.getAudioFiles();
    if (files.length === 0) {
      new Notice(`Aucun fichier audio trouvé dans « ${this.settings.audioDirectory} ».`);
      return;
    }

    if (insertIntoActiveNote && (() => { const f = this.app.workspace.getActiveFile(); return !f || f.extension !== 'md'; })()) {
      new Notice('Ouvre d’abord une note Markdown active pour y insérer la transcription.');
      return;
    }

    new AudioFileModal(this.app, files, this.settings.audioDirectory, async (file) => {
      const notice = new Notice(`Whisper : démarrage de ${file.name}`, 0);
      try {
        const client = new WhisperMcpClient(this.settings);
        const text = await client.transcribe(file, this.app, (message) => notice.setMessage(`Whisper : ${message}`));

        if (insertIntoActiveNote) {
          const activeFile = this.app.workspace.getActiveFile();
          if (!activeFile || activeFile.extension !== 'md') {
            notice.hide();
            new Notice('La note active n’est plus disponible pour l’insertion.');
            return;
          }

          const heading = `## Transcription Whisper\n`;
          const metadata = `\n> **Fichier audio :** ${markdownAudioLink(file, activeFile)}\n> **Modèle :** ${this.settings.model}\n> **Langue :** ${this.settings.language}\n`;
          const block = `\n${heading}${metadata}\n${text.trim()}\n`;

          await this.app.vault.append(activeFile, block);
          notice.hide();
          new Notice(`Transcription insérée dans « ${activeFile.basename} ».`);
          return;
        }

        notice.hide();
        new ResultModal(this.app, text).open();
      } catch (error) {
        notice.hide();
        const message = error instanceof Error ? error.message : String(error);
        console.error('Whisper MCP error', error);
        new Notice(`Whisper MCP : ${message}`, 15000);
      }
    }).open();
  }
}
