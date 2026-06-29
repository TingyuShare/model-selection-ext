import * as vscode from 'vscode';
import * as path from 'path';
import { ModelSelectorProvider } from './modelSelector';
import { ModelSelectorLanguageModelProvider } from './languageModelProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Model Selector extension activated');

    const modelSelector = new ModelSelectorProvider(context);
    modelSelector.ensureConfigFile();

    // Register language model provider for VS Code Chat
    const languageModelProvider = new ModelSelectorLanguageModelProvider(modelSelector);
    const lmDisposable = vscode.lm.registerLanguageModelChatProvider(
        'model-selector',
        languageModelProvider
    );
    context.subscriptions.push(lmDisposable);
    context.subscriptions.push({ dispose: () => modelSelector.dispose() });
    context.subscriptions.push({ dispose: () => languageModelProvider.dispose() });

    // Also react to internal config changes (e.g. saveSelectedModel, saveModels)
    context.subscriptions.push(
        modelSelector.onDidChangeConfig(() => languageModelProvider.fireChange())
    );

    // Fire initial change so Chat panel queries available models immediately
    languageModelProvider.fireChange();

    // Watch config file for changes (workspace and global storage)
    const setupWatcher = (uri: vscode.Uri | undefined) => {
        if (!uri) return;
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.joinPath(uri, '..'),
                path.basename(uri.fsPath)
            )
        );
        const onConfigFileChange = () => {
            console.log('[ModelSelector] Config file changed, refreshing...');
            modelSelector.invalidateCache();
            languageModelProvider.fireChange();
        };
        watcher.onDidChange(() => onConfigFileChange());
        watcher.onDidCreate(() => onConfigFileChange());
        watcher.onDidDelete(() => onConfigFileChange());
        context.subscriptions.push(watcher);
    };

    // Watch the unified global config file
    const globalConfigPath = modelSelector.getGlobalConfigFilePath();
    if (globalConfigPath) {
        setupWatcher(vscode.Uri.file(globalConfigPath));
    }

    // Also listen for VS Code configuration changes (e.g. settings UI edits)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('modelSelector')) {
                modelSelector.invalidateCache();
                languageModelProvider.fireChange();
            }
        })
    );

    // Config command
    const configCmd = vscode.commands.registerCommand(
        'modelSelector.config',
        async () => {
            modelSelector.ensureConfigFile();
            const uri = modelSelector.getConfigFileUri();
            if (uri) {
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                } catch (e) {
                    vscode.window.showErrorMessage(`Failed to open config: ${e}`);
                }
            }
        }
    );
    context.subscriptions.push(configCmd);
}

export function deactivate() {}