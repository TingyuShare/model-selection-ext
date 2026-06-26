import * as vscode from 'vscode';
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

    // Watch config file for changes
    const configUri = modelSelector.getConfigFileUri();
    if (configUri) {
        const watcher = vscode.workspace.createFileSystemWatcher(configUri.fsPath);
        watcher.onDidChange(() => {
            languageModelProvider.fireChange();
            vscode.window.showInformationMessage('Model config reloaded. Select the model in VS Code Chat.');
        });
        watcher.onDidCreate(() => {
            languageModelProvider.fireChange();
            vscode.window.showInformationMessage('Model config created. Select the model in VS Code Chat.');
        });
        context.subscriptions.push(watcher);
    }

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