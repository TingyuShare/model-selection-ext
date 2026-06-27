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

    // Guide user to enable the provider in Chat settings
    vscode.window.showInformationMessage(
        'AI Model Selector is active. To use it, open Chat, click the model selector, and enable "AI Model Selector" in Manage Models.',
        'Open Chat'
    ).then(choice => {
        if (choice === 'Open Chat') {
            vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
        }
    });

    // Watch config file for changes
    const configUri = modelSelector.getConfigFileUri();
    if (configUri) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.joinPath(configUri, '..'),
                path.basename(configUri.fsPath)
            )
        );
        const onConfigFileChange = () => {
            modelSelector.invalidateCache();
            languageModelProvider.fireChange();
        };
        watcher.onDidChange(() => {
            onConfigFileChange();
            vscode.window.showInformationMessage('Model config reloaded. Select the model in VS Code Chat.');
        });
        watcher.onDidCreate(() => {
            onConfigFileChange();
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