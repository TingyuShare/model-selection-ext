import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ModelEntry {
    id: string;
    name: string;
    vendor: string;
    apiKey: string;
    url: string;
    maxInputTokens: number;
    maxOutputTokens: number;
}

const DEFAULT_MODELS: ModelEntry[] = [
    {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        vendor: "deepseek",
        apiKey: "",
        
        url: "https://api.deepseek.com/v1/chat/completions",
        
        
        maxInputTokens: 128000,
        maxOutputTokens: 16000
    },
    {
        id: "deepseek-reasoner",
        name: "DeepSeek R1",
        vendor: "deepseek",
        apiKey: "",
        
        url: "https://api.deepseek.com/v1/chat/completions",
        
        
        maxInputTokens: 128000,
        maxOutputTokens: 16000
    },
    {
        id: "qwen-plus",
        name: "Qwen Plus",
        vendor: "alibaba",
        apiKey: "",
        
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        
        
        maxInputTokens: 128000,
        maxOutputTokens: 8192
    },
    {
        id: "qwen-max",
        name: "Qwen Max",
        vendor: "alibaba",
        apiKey: "",
        
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        
        
        maxInputTokens: 32768,
        maxOutputTokens: 8192
    },
    {
        id: "qwen-vl-max",
        name: "Qwen VL Max",
        vendor: "alibaba",
        apiKey: "",
        
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        
        
        maxInputTokens: 32768,
        maxOutputTokens: 8192
    },
    {
        id: "llama3",
        name: "Llama 3 (Local)",
        vendor: "ollama",
        apiKey: "ollama",
        
        url: "http://localhost:11434/v1/chat/completions",
        
        
        maxInputTokens: 8192,
        maxOutputTokens: 4096
    }
];

export class ModelSelectorProvider {
    private context: vscode.ExtensionContext;
    private configFilePath: string | undefined;
    private _onDidChangeConfig = new vscode.EventEmitter<void>();
    readonly onDidChangeConfig = this._onDidChangeConfig.event;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.configFilePath = this.getConfigFilePath();
    }

    private getConfigFilePath(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'model.json');
        }
        const storagePath = this.context.globalStorageUri?.fsPath;
        if (storagePath) {
            return path.join(storagePath, 'model.json');
        }
        return undefined;
    }

    getConfigFileUri(): vscode.Uri | undefined {
        if (!this.configFilePath) return undefined;
        return vscode.Uri.file(this.configFilePath);
    }

    ensureConfigFile(): void {
        if (!this.configFilePath) return;

        const dir = path.dirname(this.configFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (!fs.existsSync(this.configFilePath)) {
            const defaultContent = JSON.stringify({
                selectedModel: "deepseek-chat",
                models: DEFAULT_MODELS
            }, null, 2);
            fs.writeFileSync(this.configFilePath, defaultContent, 'utf-8');
        }
    }

    private readConfigFromFile(): { selectedModel: string; models: ModelEntry[] } {
        if (!this.configFilePath || !fs.existsSync(this.configFilePath)) {
            return { selectedModel: "deepseek-chat", models: DEFAULT_MODELS };
        }

        try {
            const content = fs.readFileSync(this.configFilePath, 'utf-8');
            const config = JSON.parse(content);

            // Support both old format (endpoints) and new format (models)
            if (Array.isArray(config.models)) {
                return {
                    selectedModel: config.selectedModel || "deepseek-chat",
                    models: config.models
                };
            }

            // Convert old endpoints format to new models format
            if (Array.isArray(config.endpoints)) {
                const models: ModelEntry[] = [];
                for (const ep of config.endpoints) {
                    for (const m of ep.models) {
                        models.push({
                            id: m.id,
                            name: m.name,
                            vendor: ep.vendor,
                            apiKey: ep.apiKey,
                            url: m.url,
                            maxInputTokens: m.maxInputTokens,
                            maxOutputTokens: m.maxOutputTokens
                        });
                    }
                }
                return { selectedModel: config.selectedModel || "deepseek-chat", models };
            }

            return { selectedModel: "deepseek-chat", models: DEFAULT_MODELS };
        } catch (e) {
            console.error('Failed to read model config:', e);
            return { selectedModel: "deepseek-chat", models: DEFAULT_MODELS };
        }
    }

    private writeConfigToFile(config: { selectedModel?: string; models?: ModelEntry[] }): void {
        if (!this.configFilePath) return;

        const current = this.readConfigFromFile();
        const merged = { ...current, ...config };
        fs.writeFileSync(this.configFilePath, JSON.stringify(merged, null, 2), 'utf-8');
        this._onDidChangeConfig.fire();
    }

    getModels(): ModelEntry[] {
        return this.readConfigFromFile().models;
    }

    getSelectedModelId(): string {
        return this.readConfigFromFile().selectedModel;
    }

    async saveSelectedModel(modelId: string): Promise<void> {
        this.writeConfigToFile({ selectedModel: modelId });
    }

    async saveModels(models: ModelEntry[]): Promise<void> {
        this.writeConfigToFile({ models });
    }

    findModelById(modelId: string): ModelEntry | undefined {
        return this.getModels().find(m => m.id === modelId);
    }

    async selectModel(): Promise<void> {
        const models = this.getModels();
        const selectedId = this.getSelectedModelId();

        if (models.length === 0) {
            vscode.window.showWarningMessage('No models configured. Run "ai-model: Config" to add models.');
            return;
        }

        const items: (vscode.QuickPickItem & { modelId: string })[] = models.map(m => ({
            label: m.name,
            description: `${m.vendor}${m.id === selectedId ? '  $(check)' : ''}`,
            detail: m.id,
            modelId: m.id,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select an AI model',
            title: 'ai-model: Select Model',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        if (selected) {
            await this.saveSelectedModel(selected.modelId);
            vscode.window.showInformationMessage(`Selected model: ${selected.label}`);
        }
    }
}
