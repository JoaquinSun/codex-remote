(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexImageDrop = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function hasFiles(event) {
    const transfer = event.dataTransfer;
    return Boolean(transfer && (transfer.files?.length ||
      Array.from(transfer.types || []).includes('Files') ||
      Array.from(transfer.items || []).some((item) => item.kind === 'file')));
  }

  function bind(options) {
    let depth = 0;
    const active = (value) => options.onActive(Boolean(value && options.canAttach()));
    const reset = () => { depth = 0; active(false); };

    options.target.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      active(true);
    });
    options.target.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = options.canAttach() ? 'copy' : 'none';
      active(true);
    });
    options.target.addEventListener('dragleave', () => {
      if (depth > 0) depth--;
      if (!depth) active(false);
    });
    options.target.addEventListener('drop', async (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      reset();
      if (!options.canAttach()) {
        options.onRejected('请先打开一条对话，再添加图片');
        return;
      }
      const transfer = event.dataTransfer;
      const files = transfer.files?.length ? Array.from(transfer.files)
        : Array.from(transfer.items || []).map((item) => item.getAsFile?.()).filter(Boolean);
      const images = files.filter((file) => file.type?.startsWith('image/'));
      if (!images.length) {
        options.onRejected('仅支持拖入图片文件');
        return;
      }
      await options.onFiles(images);
    });
    options.target.addEventListener('dragend', reset);
    options.target.addEventListener('keydown', (event) => { if (event.key === 'Escape') reset(); });
    options.viewport.addEventListener('blur', reset);
    return reset;
  }

  return { bind };
});
