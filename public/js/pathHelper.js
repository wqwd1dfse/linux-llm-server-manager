// Browser-compatible POSIX path utilities

(function () {
  const pathHelper = {
    normalize(p) {
      if (!p || typeof p !== 'string') return '/';
      const isAbs = p.startsWith('/');
      const parts = p.split('/').filter(Boolean);
      const stack = [];

      for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') {
          if (stack.length > 0) stack.pop();
        } else {
          stack.push(part);
        }
      }

      const res = stack.join('/');
      return isAbs ? `/${res}` : (res || '.');
    },

    join(...args) {
      const filtered = args.filter(a => typeof a === 'string' && a.length > 0);
      if (filtered.length === 0) return '.';
      return this.normalize(filtered.join('/'));
    },

    dirname(p) {
      if (!p || typeof p !== 'string') return '.';
      const norm = this.normalize(p);
      if (norm === '/') return '/';
      const idx = norm.lastIndexOf('/');
      if (idx === -1) return '.';
      if (idx === 0) return '/';
      return norm.slice(0, idx);
    },

    basename(p, ext = '') {
      if (!p || typeof p !== 'string') return '';
      const norm = this.normalize(p);
      const idx = norm.lastIndexOf('/');
      let base = idx === -1 ? norm : norm.slice(idx + 1);
      if (ext && base.endsWith(ext)) {
        base = base.slice(0, -ext.length);
      }
      return base;
    },

    extname(p) {
      if (!p || typeof p !== 'string') return '';
      const base = this.basename(p);
      const idx = base.lastIndexOf('.');
      if (idx <= 0) return '';
      return base.slice(idx);
    }
  };

  pathHelper.posix = pathHelper;
  window.pathHelper = pathHelper;
  window.path = pathHelper;
})();
