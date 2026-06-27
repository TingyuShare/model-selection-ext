import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { ModelEntry, ModelSelectorProvider, getModelName, getModelVendor, getModelKey } from './modelSelector';

interface OpenAIToolCallChunk {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
}

interface OpenAIResponse {
    choices: Array<{
        message?: {
            content: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
            }> | null;
        };
        delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: OpenAIToolCallChunk[] | null;
        };
    }>;
}

interface AnthropicResponse {
    content: Array<{
        type: string;
        text: string;
    }>;
}

interface GoogleResponse {
    candidates: Array<{
        content: {
            parts: Array<{ text: string }>;
        };
    }>;
}

export class ModelSelectorLanguageModelProvider implements vscode.LanguageModelChatProvider {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    private selectorProvider: ModelSelectorProvider;

    constructor(selectorProvider: ModelSelectorProvider) {
        this.selectorProvider = selectorProvider;
    }

    fireChange(): void {
        this._onDidChange.fire();
    }

    dispose(): void {
        this._onDidChange.dispose();
    }

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const models = this.selectorProvider.getModels();
        const selectedKey = this.selectorProvider.getSelectedModelId();

        // Sort: selected model first
        const sorted = [...models].sort((a, b) => {
            if (getModelKey(a) === selectedKey) return -1;
            if (getModelKey(b) === selectedKey) return 1;
            return 0;
        });

        return sorted.map(m => ({
            id: getModelKey(m),
            name: getModelName(m),
            family: m.id,
            version: '1.0.0',
            tooltip: `${getModelName(m)} · ${m.baseUrl || 'default endpoint'}`,
            detail: 'AI Model Selector',
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            capabilities: {
                imageInput: m.imageInput ?? true,
                toolCalling: m.toolCalling ?? true,
            },
        }));
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        _options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const m = this.selectorProvider.findModelByKey(model.id);
        if (!m) {
            throw new Error(`Model "${model.id}" not found in configuration`);
        }

        if (!m.apiKey) {
            throw new Error(
                `No API key configured for "${getModelName(m)}". ` +
                `Run "ai-model: Config" to set it.`
            );
        }

        const chatMessages = this.extractPrompt(messages);

        // Prevent infinite tool call loops
        const MAX_TOOL_ROUNDS = 5;
        const toolCallCount = messages.filter(m =>
            m.content.some(p => p instanceof vscode.LanguageModelToolCallPart)
        ).length;
        if (toolCallCount >= MAX_TOOL_ROUNDS) {
            console.log(`[ModelSelector] Max tool rounds (${MAX_TOOL_ROUNDS}) reached, stopping tool loop`);
            progress.report(new vscode.LanguageModelTextPart(
                '[Max tool call rounds reached. Please try a simpler request.]'
            ));
            return;
        }
        if (chatMessages.length === 0) {
            chatMessages.push({ role: 'user', content: 'Hello' });
        }

        // Merge tools from options (passed by VS Code) with all globally registered tools
        const optionToolNames = new Set(_options.tools?.map(t => t.name) ?? []);
        const allTools: Array<{ type: string; function: { name: string; description: string; parameters: object } }> = [];

        // Add tools from options
        for (const t of _options.tools ?? []) {
            allTools.push({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema || { type: 'object', properties: {} },
                },
            });
        }

        // Add any globally registered tools not already in options
        for (const t of vscode.lm.tools) {
            if (!optionToolNames.has(t.name)) {
                allTools.push({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema || { type: 'object', properties: {} },
                    },
                });
            }
        }

        await this.callChatCompletions(m, chatMessages, progress, token, allTools);
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }
        let totalLength = 0;
        for (const part of text.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                totalLength += part.value.length;
            }
        }
        return Math.ceil(totalLength / 4);
    }

    private extractPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{
        role: string;
        content?: string;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        tool_call_id?: string;
        content_parts?: Array<{ type: string; text?: string }>;
    }> {
        const chatMessages: Array<{
            role: string;
            content?: string;
            tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
            tool_call_id?: string;
            content_parts?: Array<{ type: string; text?: string }>;
        }> = [];

        for (const msg of messages) {
            // VS Code roles: 1=User, 2=Assistant, 3=System
            let role: string;
            if (msg.role === vscode.LanguageModelChatMessageRole.User) {
                role = 'user';
            } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
                role = 'assistant';
            } else {
                role = 'system';
            }

            let textContent = '';
            const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
            let toolCallId: string | undefined;
            let hasToolResult = false;

            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textContent += part.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    // VS Code is sending back tool calls from the assistant
                    // We need to preserve them in the message history
                    toolCalls.push({
                        id: part.callId,
                        type: 'function',
                        function: {
                            name: part.name,
                            arguments: JSON.stringify(part.input),
                        },
                    });
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    // VS Code executed a tool and is sending back the result
                    hasToolResult = true;
                    toolCallId = part.callId;
                    if (typeof part.content === 'string') {
                        textContent += part.content;
                    } else if (Array.isArray(part.content)) {
                        // LanguageModelToolResultContent[]
                        for (const item of part.content) {
                            if (item && typeof item === 'object' && 'value' in item) {
                                textContent += item.value;
                            } else {
                                textContent += JSON.stringify(item);
                            }
                        }
                    } else {
                        textContent += JSON.stringify(part.content);
                    }
                }
            }

            if (hasToolResult && toolCallId) {
                // Tool result message - must be "tool" role with tool_call_id
                chatMessages.push({
                    role: 'tool',
                    content: textContent || '',
                    tool_call_id: toolCallId,
                });
            } else if (role === 'assistant' && toolCalls.length > 0) {
                // Assistant message with tool calls - must include tool_calls array
                // Filter out tool calls with empty names (invalid)
                const validToolCalls = toolCalls.filter(tc => tc.function.name);
                chatMessages.push({
                    role: 'assistant',
                    content: textContent || '',
                    tool_calls: validToolCalls.length > 0 ? validToolCalls : undefined,
                });
            } else if (role === 'user') {
                chatMessages.push({ role: 'user', content: textContent });
            } else if (role === 'assistant') {
                chatMessages.push({ role: 'assistant', content: textContent });
            } else if (role === 'system') {
                chatMessages.push({ role: 'system', content: textContent });
            }
        }
        return chatMessages;
    }

    private async callChatCompletions(
        m: ModelEntry,
        messages: Array<{
            role: string;
            content?: string;
            tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
            tool_call_id?: string;
        }>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        tools?: Array<{ type: string; function: { name: string; description: string; parameters: object } }>
    ): Promise<void> {
        const bodyObj: Record<string, unknown> = {
            model: m.id,
            messages,
            stream: true,
        };
        if (tools && tools.length > 0) {
            bodyObj.tools = tools;
        }
        const body = JSON.stringify(bodyObj);

        const endpoint = (m.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
        const url = new URL(endpoint);

        const responseStream = await this.httpStreamRequest({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${m.apiKey}`,
            },
        }, body, token);

        const decoder = new TextDecoder();
        let buffer = '';
        // Accumulate streaming tool calls by index (OpenAI sends tool calls in fragments)
        const toolCallAccumulator = new Map<number, { id?: string; name?: string; arguments: string }>();
        let hasReportedContent = false;
        let isNonStreamResponse = false;

        for await (const sseChunk of responseStream) {
            buffer += decoder.decode(sseChunk, { stream: true });

            // Detect non-streaming JSON response (some providers return full JSON instead of SSE)
            if (!isNonStreamResponse && buffer.trimStart().startsWith('{')) {
                isNonStreamResponse = true;
            }

            const lines = buffer.split('\n');
            buffer = lines.pop()!; // keep incomplete line in buffer

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Support both "data: json" and "data:json" (non-standard)
                let data: string | undefined;
                if (trimmed.startsWith('data: ')) {
                    data = trimmed.slice(6);
                } else if (trimmed.startsWith('data:')) {
                    data = trimmed.slice(5);
                }
                if (data === undefined) continue;
                if (data === '[DONE]') break;

                try {
                    const parsed = JSON.parse(data) as OpenAIResponse;
                    const chunk = parsed.choices?.[0]?.delta;
                    if (!chunk) continue;

                    if (chunk.tool_calls) {
                        for (const tc of chunk.tool_calls) {
                            const idx = tc.index ?? 0;
                            let existing = toolCallAccumulator.get(idx);
                            if (!existing) {
                                existing = { arguments: '' };
                                toolCallAccumulator.set(idx, existing);
                            }
                            if (tc.id) { existing.id = tc.id; }
                            if (tc.function?.name) { existing.name = tc.function.name; }
                            if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
                        }
                    }

                    const text = chunk.content || chunk.reasoning_content || '';
                    if (text) {
                        hasReportedContent = true;
                        progress.report(new vscode.LanguageModelTextPart(text));
                    }
                } catch { /* skip malformed SSE line */ }
            }
        }

        // Now report accumulated tool calls with complete arguments
        for (const [, tc] of toolCallAccumulator) {
            if (!tc.id || !tc.name) { continue; }
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.arguments); } catch { /* ignore */ }
            console.log(`[ModelSelector] Tool call: ${tc.name}(${JSON.stringify(args)})`);
            hasReportedContent = true;
            progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
        }

        // Handle non-streaming JSON response (provider returned full JSON instead of SSE)
        if (isNonStreamResponse && !hasReportedContent && buffer.trim()) {
            try {
                const parsed = JSON.parse(buffer) as OpenAIResponse;
                const message = parsed.choices?.[0]?.message;
                if (message) {
                    const text = message.content || message.reasoning_content || '';
                    if (text) {
                        hasReportedContent = true;
                        progress.report(new vscode.LanguageModelTextPart(text));
                    }
                    if (message.tool_calls) {
                        for (const tc of message.tool_calls) {
                            let args: Record<string, unknown> = {};
                            try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
                            hasReportedContent = true;
                            progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args));
                        }
                    }
                }
            } catch { /* ignore parse error */ }
        }

        // If nothing was reported (no text, no tool calls), report a placeholder
        if (!hasReportedContent) {
            console.warn('[ModelSelector] Stream completed with no content. Reporting empty response.');
            progress.report(new vscode.LanguageModelTextPart(''));
        }
    }

    /**
     * Anthropic messages API
     */
    private async callMessages(
        m: ModelEntry,
        messages: { role: string; content: string }[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Ensure alternating user/assistant starting with user
        const chatMessages: { role: string; content: string }[] = [];
        for (const msg of messages) {
            if (chatMessages.length === 0 && msg.role !== 'user') {
                chatMessages.push({ role: 'user', content: 'Hello' });
            }
            chatMessages.push(msg);
        }
        if (chatMessages.length === 0 || chatMessages[0].role !== 'user') {
            chatMessages.unshift({ role: 'user', content: 'Hello' });
        }
        if (chatMessages[chatMessages.length - 1].role !== 'user') {
            chatMessages.push({ role: 'user', content: 'Please continue' });
        }

        const body = JSON.stringify({
            model: m.id,
            max_tokens: m.maxOutputTokens,
            messages: chatMessages,
        });

        const endpoint = (m.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '') + '/messages';
        const url = new URL(endpoint);
        const response = await this.httpRequest({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': m.apiKey,
                'anthropic-version': '2023-06-01',
            },
        }, body, token);

        const data = JSON.parse(response) as AnthropicResponse;
        if (data.content && data.content.length > 0) {
            const text = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
            progress.report(new vscode.LanguageModelTextPart(text));
        }
    }

    /**
     * Google generateContent API
     */
    private async callGenerateContent(
        m: ModelEntry,
        messages: { role: string; content: string }[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const contents = messages.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }],
        }));

        const body = JSON.stringify({
            contents,
            generationConfig: {
                maxOutputTokens: m.maxOutputTokens,
            },
        });

        const endpoint = (m.baseUrl ||
            `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent`
        ).replace(/\/+$/, '');
        const separator = endpoint.includes('?') ? '&' : '?';
        const url = new URL(endpoint + `${separator}key=${m.apiKey}`);
        const response = await this.httpRequest({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        }, body, token);

        const data = JSON.parse(response) as GoogleResponse;
        if (data.candidates && data.candidates.length > 0) {
            const text = data.candidates[0].content.parts.map(p => p.text).join('');
            progress.report(new vscode.LanguageModelTextPart(text));
        }
    }

    private async httpStreamRequest(
        options: https.RequestOptions,
        body: string,
        token: vscode.CancellationToken,
        timeoutMs: number = 120000,
        maxRetries: number = 3
    ): Promise<AsyncIterable<Buffer>> {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await new Promise<AsyncIterable<Buffer>>((resolve, reject) => {
                    const transport = options.port === 80 || options.port === '80' ? http : https;
                    const req = transport.request(options, (res) => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(res as unknown as AsyncIterable<Buffer>);
                        } else if (res.statusCode === 429) {
                            let errData = '';
                            res.on('data', (chunk) => { errData += chunk; });
                            res.on('end', () => { reject(new Error(`RATE_LIMITED:${errData}`)); });
                        } else {
                            let errData = '';
                            res.on('data', (chunk) => { errData += chunk; });
                            res.on('end', () => { reject(new Error(`API request failed (${res.statusCode}): ${errData}`)); });
                        }
                    });
                    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Request timed out after ${timeoutMs}ms`)); });
                    req.on('error', reject);
                    token.onCancellationRequested(() => { req.destroy(); reject(new Error('Request cancelled')); });
                    req.write(body);
                    req.end();
                });
            } catch (e: unknown) {
                if (e instanceof Error && e.message.startsWith('RATE_LIMITED:') && attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                    console.log(`[ModelSelector] Rate limited, retrying in ${delay}ms (${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw e;
            }
        }
        throw new Error('Max retries exceeded');
    }

    private httpRequest(
        options: https.RequestOptions,
        body: string,
        token: vscode.CancellationToken,
        timeoutMs: number = 60000,
        retries: number = 3
    ): Promise<string> {
        return this.httpRequestWithRetry(options, body, token, timeoutMs, retries, 0);
    }

    private httpRequestWithRetry(
        options: https.RequestOptions,
        body: string,
        token: vscode.CancellationToken,
        timeoutMs: number,
        maxRetries: number,
        attempt: number
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const transport = options.port === 80 || options.port === '80' ? http : https;
            const req = transport.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', async () => {
                    if (res.statusCode === 429 && attempt < maxRetries) {
                        // Rate limited - retry with exponential backoff
                        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                        console.log(`[ModelSelector] Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(r => setTimeout(r, delay));
                        try {
                            resolve(await this.httpRequestWithRetry(options, body, token, timeoutMs, maxRetries, attempt + 1));
                        } catch (e) {
                            reject(e);
                        }
                        return;
                    }
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`API request failed (${res.statusCode}): ${data}`));
                    }
                });
            });

            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
            });

            req.on('error', reject);

            token.onCancellationRequested(() => {
                req.destroy();
                reject(new Error('Request cancelled'));
            });

            req.write(body);
            req.end();
        });
    }
}