// Loads trusted static UI fragments before DOMContentLoaded initialization runs.
window.uiFragmentsReady = (async () => {
  const root = document.getElementById('modal-root');
  if (!root) {
    console.error('[Bootstrap] Modal root is missing');
    return false;
  }

  root.setAttribute('aria-busy', 'true');

  try {
    const response = await fetch('/fragments/modals.html', {
      credentials: 'same-origin',
      cache: 'no-cache',
      headers: { Accept: 'text/html' }
    });

    if (!response.ok) {
      throw new Error(`UI fragment request failed (${response.status})`);
    }

    const template = document.createElement('template');
    template.innerHTML = (await response.text()).trim();

    const hasScript = Boolean(template.content.querySelector('script'));
    const hasInlineHandler = [...template.content.querySelectorAll('*')].some((element) =>
      [...element.attributes].some((attribute) => attribute.name.toLowerCase().startsWith('on'))
    );
    if (hasScript || hasInlineHandler) {
      throw new Error('UI fragment contains disallowed executable markup');
    }

    root.replaceChildren(template.content.cloneNode(true));
    return true;
  } catch (error) {
    console.error('[Bootstrap] Unable to load UI fragments:', error);
    const alert = document.createElement('div');
    alert.className = 'bootstrap-error';
    alert.setAttribute('role', 'alert');
    alert.textContent = '管理界面组件加载失败，请刷新页面；若问题持续，请检查服务静态文件是否完整。';
    root.replaceChildren(alert);
    return false;
  } finally {
    root.setAttribute('aria-busy', 'false');
  }
})();
