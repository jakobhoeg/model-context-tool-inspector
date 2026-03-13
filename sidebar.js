/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  streamText,
  generateText,
  tool,
  jsonSchema,
  stepCountIs,
  browserAI,
  doesBrowserSupportBrowserAI,
} from './ai-bundle.js';

const statusDiv = document.getElementById('status');
const tbody = document.getElementById('tableBody');
const thead = document.getElementById('tableHeaderRow');
const copyToClipboard = document.getElementById('copyToClipboard');
const copyAsScriptToolConfig = document.getElementById('copyAsScriptToolConfig');
const copyAsJSON = document.getElementById('copyAsJSON');
const toolNames = document.getElementById('toolNames');
const inputArgsText = document.getElementById('inputArgsText');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const promptBtn = document.getElementById('promptBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const promptResults = document.getElementById('promptResults');
const downloadProgress = document.getElementById('downloadProgress');

// Inject content script first.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS' });
  } catch (error) {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = error;
    statusDiv.hidden = false;
    copyToClipboard.hidden = true;
  }
})();

let currentTools;

let userPromptPendingId = 0;
let lastSuggestedUserPrompt = '';

// Listen for the results coming back from content.js
chrome.runtime.onMessage.addListener(async ({ message, tools, url }, sender) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sender.tab && sender.tab.id !== tab.id) return;

  tbody.innerHTML = '';
  thead.innerHTML = '';
  toolNames.innerHTML = '';

  statusDiv.textContent = message;
  statusDiv.hidden = !message;

  const haveNewTools = JSON.stringify(currentTools) !== JSON.stringify(tools);

  currentTools = tools;

  if (!tools || tools.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="100%"><i>No tools registered yet in ${url || tab.url}</i></td>`;
    tbody.appendChild(row);
    inputArgsText.value = '';
    inputArgsText.disabled = true;
    toolNames.disabled = true;
    executeBtn.disabled = true;
    copyToClipboard.hidden = true;
    return;
  }

  inputArgsText.disabled = false;
  toolNames.disabled = false;
  executeBtn.disabled = false;
  copyToClipboard.hidden = false;

  const keys = Object.keys(tools[0]);
  keys.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    thead.appendChild(th);
  });

  tools.forEach((item) => {
    const row = document.createElement('tr');
    keys.forEach((key) => {
      const td = document.createElement('td');
      try {
        td.innerHTML = `<pre>${JSON.stringify(JSON.parse(item[key]), '', '  ')}</pre>`;
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);

    const option = document.createElement('option');
    option.textContent = `"${item.name}"`;
    option.value = item.name;
    option.dataset.inputSchema = item.inputSchema;
    toolNames.appendChild(option);
  });
  updateDefaultValueForInputArgs();

  if (haveNewTools) suggestUserPrompt();
});

tbody.ondblclick = () => {
  tbody.classList.toggle('prettify');
};

copyAsScriptToolConfig.onclick = async () => {
  const text = currentTools
    .map((tool) => {
      return `\
script_tools {
  name: "${tool.name}"
  description: "${tool.description}"
  input_schema: ${JSON.stringify(tool.inputSchema || { type: 'object', properties: {} })}
}`;
    })
    .join('\r\n');
  await navigator.clipboard.writeText(text);
};

copyAsJSON.onclick = async () => {
  const tools = currentTools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
        ? JSON.parse(tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  await navigator.clipboard.writeText(JSON.stringify(tools, '', '  '));
};

// Browser AI

// Use separate browserAI instances for suggestion vs prompting
// to avoid Chrome Prompt API session caching issues (system prompt
// is fixed at session creation time).
let suggestModel;
let promptModel;
let messages = [];

function createModels() {
  suggestModel = browserAI();
  promptModel = browserAI();
}

async function initBrowserAI() {
  if (!doesBrowserSupportBrowserAI()) {
    logPrompt(
      'Browser AI not available. Requires Chrome 128+ with Prompt API flags enabled.\n' +
        'Enable: chrome://flags/#optimization-guide-on-device-model\n' +
        'Enable: chrome://flags/#prompt-api-for-gemini-nano-multimodal-input',
    );
    return;
  }

  createModels();

  const availability = await suggestModel.availability();

  if (availability === 'unavailable') {
    logPrompt('Browser AI model unavailable. Enable the on-device model flag and restart Chrome.');
    return;
  }

  if (availability === 'downloadable') {
    downloadProgress.hidden = false;
    downloadProgress.textContent = 'Downloading AI model...';
    await suggestModel.createSessionWithProgress((progress) => {
      const percent = Math.round(progress * 100);
      downloadProgress.textContent = `Downloading AI model... ${percent}%`;
      if (progress >= 1) {
        downloadProgress.textContent = 'Model ready!';
        setTimeout(() => {
          downloadProgress.hidden = true;
        }, 2000);
      }
    });
  }

  promptBtn.disabled = false;
  resetBtn.disabled = false;
}
initBrowserAI();

async function suggestUserPrompt() {
  if (!currentTools || currentTools.length === 0 || !suggestModel || userPromptText.value !== lastSuggestedUserPrompt)
    return;
  const userPromptId = ++userPromptPendingId;
  try {
    const result = await generateText({
      model: suggestModel,
      prompt: [
        '**Context:**',
        `Today's date is: ${getFormattedDate()}`,
        '**Task:**',
        'Generate one natural user query for a range of tools below, ideally chaining them together.',
        'Ensure the date makes sense relative to today.',
        'Output the query text only.',
        '**Tools:**',
        JSON.stringify(currentTools),
      ].join('\n'),
    });
    if (userPromptId !== userPromptPendingId || userPromptText.value !== lastSuggestedUserPrompt)
      return;
    lastSuggestedUserPrompt = result.text;
    userPromptText.value = '';
    for (const chunk of result.text) {
      await new Promise((r) => requestAnimationFrame(r));
      userPromptText.value += chunk;
    }
  } catch (e) {
    console.warn('Failed to suggest user prompt:', e);
  }
}

userPromptText.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    promptBtn.click();
  }
};

promptBtn.onclick = async () => {
  try {
    await promptAI();
  } catch (error) {
    trace.push({ error });
    logPrompt(`Error: "${error}"`);
  }
};

let trace = [];

function getAITools() {
  const aiTools = {};
  for (const t of currentTools) {
    const schema = t.inputSchema ? JSON.parse(t.inputSchema) : { type: 'object', properties: {} };
    aiTools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(schema),
      execute: async (args) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const inputArgs = JSON.stringify(args);
        logPrompt(`AI calling tool "${t.name}" with ${inputArgs}`);
        try {
          const result = await executeTool(tab.id, t.name, inputArgs);
          logPrompt(`Tool "${t.name}" result: ${result}`);
          // Artificial delay for cross-document tool discovery after navigation
          await new Promise((r) => setTimeout(r, 500));
          return result;
        } catch (e) {
          logPrompt(`Error executing tool "${t.name}": ${e.message}`);
          return { error: e.message };
        }
      },
    });
  }
  return aiTools;
}

function getSystemPrompt() {
  return [
    'You are an assistant embedded in a browser tab.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use your tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}`,
    "CRITICAL RULE: Whenever the user provides a relative date (e.g., \"next Monday\", \"tomorrow\", \"in 3 days\"), you must calculate the exact calendar date based on today's date.",
  ].join('\n');
}

async function promptAI() {
  const message = userPromptText.value;
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  logPrompt(`User prompt: "${message}"`);

  messages.push({ role: 'user', content: message });

  const result = streamText({
    model: promptModel,
    system: getSystemPrompt(),
    messages,
    tools: getAITools(),
    stopWhen: stepCountIs(10),
    onStepFinish: (step) => {
      trace.push(step);
    },
  });

  let fullText = '';
  for await (const chunk of result.textStream) {
    fullText += chunk;
  }

  if (fullText) {
    logPrompt(`AI result: ${fullText.trim()}\n`);
  } else {
    logPrompt('AI response has no text.\n');
  }

  // Append assistant response for multi-turn conversation
  messages.push({ role: 'assistant', content: fullText || '' });
}

resetBtn.onclick = () => {
  messages = [];
  trace = [];
  createModels();
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  promptResults.textContent = '';
  suggestUserPrompt();
};

traceBtn.onclick = async () => {
  const text = JSON.stringify(trace, '', ' ');
  await navigator.clipboard.writeText(text);
};

executeBtn.onclick = async () => {
  toolResults.textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = toolNames.selectedOptions[0].value;
  const inputArgs = inputArgsText.value;
  toolResults.textContent = await executeTool(tab.id, name, inputArgs).catch(
    (error) => `Error: "${error}"`,
  );
};

async function executeTool(tabId, name, inputArgs) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'EXECUTE_TOOL',
      name,
      inputArgs,
    });
    if (result !== null) return result;
  } catch (error) {
    if (!error.message.includes('message channel is closed')) throw error;
  }
  // A navigation was triggered. The result will be on the next document.
  await waitForPageLoad(tabId);
  return await chrome.tabs.sendMessage(tabId, {
    action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT',
  });
}

toolNames.onchange = updateDefaultValueForInputArgs;

function updateDefaultValueForInputArgs() {
  const inputSchema = toolNames.selectedOptions[0].dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(JSON.parse(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
}

// Utils

function logPrompt(text) {
  promptResults.textContent += `${text}\n`;
  promptResults.scrollTop = promptResults.scrollHeight;
}

function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function generateTemplateFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (schema.hasOwnProperty('const')) {
    return schema.const;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateTemplateFromSchema(schema.oneOf[0]);
  }

  if (schema.hasOwnProperty('default')) {
    return schema.default;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  switch (schema.type) {
    case 'object':
      const obj = {};
      if (schema.properties) {
        Object.keys(schema.properties).forEach((key) => {
          obj[key] = generateTemplateFromSchema(schema.properties[key]);
        });
      }
      return obj;

    case 'array':
      if (schema.items) {
        return [generateTemplateFromSchema(schema.items)];
      }
      return [];

    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'date') {
        return new Date().toISOString().substring(0, 10);
      }
      // yyyy-MM-ddThh:mm:ss.SSS
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$'
      ) {
        return new Date().toISOString().substring(0, 23);
      }
      // yyyy-MM-ddThh:mm:ss
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      ) {
        return new Date().toISOString().substring(0, 19);
      }
      // yyyy-MM-ddThh:mm
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(0, 16);
      }
      // yyyy-MM
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])$') {
        return new Date().toISOString().substring(0, 7);
      }
      // yyyy-Www
      if (schema.format === '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') {
        return `${new Date().toISOString().substring(0, 4)}-W01`;
      }
      // HH:mm:ss.SSS
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$') {
        return new Date().toISOString().substring(11, 23);
      }
      // HH:mm:ss
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$') {
        return new Date().toISOString().substring(11, 19);
      }
      // HH:mm
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(11, 16);
      }
      if (schema.format === '^#[0-9a-zA-Z]{6}$') {
        return '#ff00ff';
      }
      if (schema.format === 'tel') {
        return '123-456-7890';
      }
      if (schema.format === 'email') {
        return 'user@example.com';
      }
      return 'example_string';

    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      return 0;

    case 'boolean':
      return false;

    case 'null':
      return null;

    default:
      return {};
  }
}

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

document.querySelectorAll('.collapsible-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    const content = header.nextElementSibling;
    if (content?.classList.contains('section-content')) {
      content.classList.toggle('is-hidden');
    }
  });
});
