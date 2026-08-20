// API helper, XSS sanitization, and UI utilities

window.escapeHtml = function (str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

window.api = {
  async request(url, options = {}) {
    try {
      const { headers = {}, ...requestOptions } = options;
      const res = await fetch(url, {
        credentials: 'same-origin',
        ...requestOptions,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      });

      let data;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        data = { success: res.ok, message: text };
      }

      if (res.status === 401) {
        if (window.showLoginModal) {
          window.showLoginModal('请先登录管理后台');
        }
        throw new Error(data.error || '未授权或登录已过期');
      }

      if (!res.ok || data.success === false) {
        throw new Error(data.error || `请求失败 (${res.status})`);
      }
      return data;
    } catch (err) {
      if (err.message !== '未授权或登录已过期') {
        window.toast(err.message, 'error');
      }
      throw err;
    }
  }
};

window.toast = function (message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const localizedMessage = window.localizeText
    ? window.localizeText(String(message))
    : String(message);

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = localizedMessage;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
};

let lastFocusedElement = null;

function getFocusableElements(container) {
  return [...container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => element.offsetParent !== null);
}

window.showModal = function (id) {
  const modal = document.getElementById(id);
  if (!modal) return;

  lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  requestAnimationFrame(() => {
    const focusable = getFocusableElements(modal);
    (focusable[0] || modal.querySelector('.modal-dialog'))?.focus();
  });
};

window.closeModal = function (id) {
  const modal = document.getElementById(id);
  if (!modal) return;

  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.modal-backdrop.show')) {
    document.body.classList.remove('modal-open');
  }
  lastFocusedElement?.focus?.();
};

document.addEventListener('DOMContentLoaded', async () => {
  const fragmentsReady = await (window.uiFragmentsReady || Promise.resolve(true));
  if (!fragmentsReady) return;
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => window.closeModal(button.getAttribute('data-close')));
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.setAttribute('aria-hidden', 'true');
    const dialog = backdrop.querySelector('.modal-dialog');
    if (dialog) {
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const title = dialog.querySelector('.modal-header-bar > span, .modal-header-bar > div');
      if (title) {
        title.id ||= `${backdrop.id}-title`;
        dialog.setAttribute('aria-labelledby', title.id);
      } else {
        dialog.setAttribute('aria-label', '管理操作');
      }
      dialog.tabIndex = -1;
    }

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop && !backdrop.hasAttribute('data-modal-static')) {
        window.closeModal(backdrop.id);
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    const openModals = [...document.querySelectorAll('.modal-backdrop.show')];
    const activeModal = openModals.at(-1);
    if (!activeModal) return;

    if (event.key === 'Escape' && !activeModal.hasAttribute('data-modal-static')) {
      event.preventDefault();
      window.closeModal(activeModal.id);
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(activeModal);
    if (!focusable.length) {
      event.preventDefault();
      activeModal.querySelector('.modal-dialog')?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
});