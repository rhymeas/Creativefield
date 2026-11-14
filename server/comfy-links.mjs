/* Quiet wires: every link is drawn at about a third of its strength, and a link comes to full strength only while its node is
   hovered or selected (or while LiteGraph highlights it). The graph stays readable instead of a bundle of bright lines. */
const REST = 0.3;
function ready() { const app = window.comfyAPI?.app?.app ?? window.app; return app?.canvas && Object.getPrototypeOf(app.canvas)?.renderLink ? app : null; }
(async () => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((r) => setTimeout(r, 250));
  const app = ready();
  if (!app) return;
  const proto = Object.getPrototypeOf(app.canvas);
  if (proto.__cfQuietLinks) return;
  proto.__cfQuietLinks = true;
  const original = proto.renderLink;
  proto.renderLink = function (ctx, a, b, link, ...rest) {
    let alpha = REST;
    if (link) {
      const touches = (node) => node && (link.origin_id === node.id || link.target_id === node.id);
      const selected = this.selected_nodes ? Object.values(this.selected_nodes) : [];
      if (this.highlighted_links?.[link.id] || touches(this.node_over) || selected.some(touches)) alpha = 1;
    }
    ctx.save();
    ctx.globalAlpha = (ctx.globalAlpha ?? 1) * alpha;
    try { return original.call(this, ctx, a, b, link, ...rest); } finally { ctx.restore(); }
  };
  app.canvas.setDirty?.(true, true);
})();
