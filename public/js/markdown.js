// Minimal escaped Markdown renderer shared by LLM chat and model README views.
window.renderMarkdown = function renderMarkdown(md) {
  if (!md) return '';
  const escape = window.escapeHtml || ((value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'));
  const source = String(md);
  const blocks = [];
  const tokenized = source.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const codeId = `code_${crypto.randomUUID?.().replace(/-/g, '') || Math.random().toString(36).slice(2)}_${blocks.length}`;
    const copyLabel = window.localize ? window.localize('复制', 'Copy') : 'Copy';
    const block = `
      <div class="chat-code-box">
        <div class="chat-code-header">
          <span>${escape(lang || 'code')}</span>
          <button class="cmd-btn btn-sm" data-action="copy-code-block" data-code-id="${codeId}">${escape(copyLabel)}</button>
        </div>
        <pre><code id="${codeId}">${escape(code)}</code></pre>
      </div>
    `;
    blocks.push(block);
    return `\u0000CODE_BLOCK_${blocks.length - 1}\u0000`;
  });

  let html = escape(tokenized);
  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\r?\n/g, '<br>');
  html = html.replace(/\u0000CODE_BLOCK_(\d+)\u0000/g, (_, index) => blocks[Number(index)] || '');
  return html;
};
