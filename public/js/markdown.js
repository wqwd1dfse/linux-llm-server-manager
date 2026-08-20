// Minimal escaped Markdown renderer shared by LLM chat and model README views.
window.renderMarkdown = function renderMarkdown(md) {
  if (!md) return '';
  let html = String(md)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const codeId = 'code_' + Math.random().toString(36).substring(2, 8);
    return `
      <div class="chat-code-box">
        <div class="chat-code-header">
          <span>${window.escapeHtml(lang) || 'code'}</span>
          <button class="cmd-btn btn-sm" data-action="copy-code-block" data-code-id="${codeId}">复制</button>
        </div>
        <pre><code id="${codeId}">${window.escapeHtml(code)}</code></pre>
      </div>
    `;
  });

  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');
  return html;
};
