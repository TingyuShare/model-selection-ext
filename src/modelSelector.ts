import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ModelEntry {
    id: string;
    name?: string;
    vendor?: string;
    apiKey: string;
    baseUrl: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    imageInput?: boolean;
    toolCalling?: boolean;
}

function deriveNameFromId(id: string): string {
    return id
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function deriveVendorFromId(id: string): string {
    const prefix = id.split(/[-_]/)[0];
    return prefix.toLowerCase();
}

export function getModelName(m: ModelEntry): string {
    return m.name || deriveNameFromId(m.id);
}

export function getModelVendor(m: ModelEntry): string {
    return m.vendor || deriveVendorFromId(m.id);
}

/**
 * Generate a unique key for a model entry.
 * If name is explicitly set, use name (since user chose it to distinguish).
 * Otherwise use id + baseUrl to handle same model from different sources.
 */
export function getModelKey(m: ModelEntry): string {
    if (m.name) { return m.name; }
    const base = (m.baseUrl || '').replace(/\/+$/, '');
    return base ? `${m.id}@${base}` : m.id;
}

const DEFAULT_MODEL_ID = "deepseek-v4-pro";

const DEFAULT_MODELS: ModelEntry[] = [
    {
        id: DEFAULT_MODEL_ID,
        name: "DeepSeek V4 Pro",
        apiKey: "",
        baseUrl: "https://api.deepseek.com/v1",
        maxInputTokens: 128000,
        maxOutputTokens: 16000
    }
];

export class ModelSelectorProvider {
    private context: vscode.ExtensionContext;
    private _cachedConfigFilePath: string | undefined;
    private _cachedModels: ModelEntry[] | undefined;
    private _selectedModelKey: string;
    private _onDidChangeConfig = new vscode.EventEmitter<void>();
    readonly onDidChangeConfig = this._onDidChangeConfig.event;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        // Restore persisted selected model from globalState
        this._selectedModelKey = context.globalState.get<string>('modelSelector.selectedModelKey', DEFAULT_MODEL_ID);
    }

    dispose(): void {
        this._onDidChangeConfig.dispose();
    }

    invalidateCache(): void {
        this._cachedModels = undefined;
    }

    private getConfigFilePath(): string | undefined {
        if (this._cachedConfigFilePath) {
            return this._cachedConfigFilePath;
        }

        const roamingDir = process.env.APPDATA;
        if (roamingDir) {
            this._cachedConfigFilePath = path.join(roamingDir, 'model-selector', 'model.json');
            return this._cachedConfigFilePath;
        }

        const homeDir = os.homedir();
        if (homeDir) {
            this._cachedConfigFilePath = path.join(homeDir, 'model-selector', 'model.json');
            return this._cachedConfigFilePath;
        }
        return undefined;
    }

    getConfigFileUri(): vscode.Uri | undefined {
        const p = this.getConfigFilePath();
        return p ? vscode.Uri.file(p) : undefined;
    }

    getGlobalConfigFilePath(): string | undefined {
        return this.getConfigFilePath();
    }

    ensureConfigFile(): void {
        const configPath = this.getConfigFilePath();
        if (!configPath) return;

        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (!fs.existsSync(configPath)) {
            const defaultContent = JSON.stringify({
                models: DEFAULT_MODELS
            }, null, 2);
            fs.writeFileSync(configPath, defaultContent, 'utf-8');
        }
    }

    private readModelsFromFile(): ModelEntry[] {
        if (this._cachedModels) {
            return this._cachedModels;
        }

        const configPath = this.getConfigFilePath();
        if (!configPath || !fs.existsSync(configPath)) {
            return DEFAULT_MODELS;
        }

        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(content);
            let models: ModelEntry[];

            if (Array.isArray(config.models)) {
                models = config.models;
            } else if (Array.isArray(config.endpoints)) {
                // Convert old endpoints format to new models format
                models = [];
                for (const ep of config.endpoints) {
                    for (const m of ep.models) {
                        models.push({
                            id: m.id,
                            name: m.name,
                            vendor: ep.vendor,
                            apiKey: ep.apiKey,
                            baseUrl: m.url || m.baseUrl,
                            maxInputTokens: m.maxInputTokens,
                            maxOutputTokens: m.maxOutputTokens
                        });
                    }
                }
            } else {
                models = DEFAULT_MODELS;
            }

            this._cachedModels = models;
            return models;
        } catch (e) {
            console.error('Failed to read model config:', e);
            return DEFAULT_MODELS;
        }
    }

    private writeModelsToFile(models: ModelEntry[]): void {
        const configPath = this.getConfigFilePath();
        if (!configPath) return;

        fs.writeFileSync(configPath, JSON.stringify({ models }, null, 2), 'utf-8');
        this._cachedModels = models;
        this._onDidChangeConfig.fire();
    }

    getModels(): ModelEntry[] {
        return this.readModelsFromFile();
    }

    getSelectedModelId(): string {
        return this._selectedModelKey;
    }

    async saveSelectedModel(modelKey: string): Promise<void> {
        this._selectedModelKey = modelKey;
        // Persist to globalState so it survives across VS Code windows/restarts
        await this.context.globalState.update('modelSelector.selectedModelKey', modelKey);
        this._onDidChangeConfig.fire();
    }

    async saveModels(models: ModelEntry[]): Promise<void> {
        this.writeModelsToFile(models);
    }

    findModelByKey(key: string): ModelEntry | undefined {
        return this.getModels().find(m => getModelKey(m) === key);
    }
}