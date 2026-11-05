import {useEffect, useState} from "react";
import {MediaCard, Meta, SectionHeader} from "../../ds";
import {assetUrl, workspacePath, type Call} from "../../team/api";
import {blankCanvas, loadBitmap} from "./bitmaps";
import {documentKeys, mapDocumentKeys} from "./document-keys";
import {validateDocument} from "./document-format";
import {renderDoc} from "./render";
import type {EditorDocument} from "./use-documents";

/** Render actual saved layers, rather than presenting a single layer as the document. */
export function RecentDocuments({records, workspaceId, projectId, call, busy, onOpen}: {
  records: EditorDocument[]; workspaceId: string; projectId: string; call: Call; busy: boolean; onOpen: (id: string) => void;
}) {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const recent = records.slice(0, 6);
  const signature = recent.map(record => `${record.id}:${record.revision}`).join("|");
  useEffect(() => {
    let active = true;
    setPreviews({});
    void (async () => {
      for (const record of recent) {
        try {
          const item = await call<EditorDocument>(workspacePath(workspaceId, `projects/${projectId}/editor-documents/${record.id}`));
          const stored = validateDocument(item.document);
          // Avoid allocating huge full-resolution composites on the start screen.
          if (stored.width * stored.height > 16_777_216) continue;
          const doc = mapDocumentKeys(stored, key => assetUrl(workspaceId, key.slice(6)));
          await Promise.all(documentKeys(doc).map(key => loadBitmap(key)));
          if (!active) return;
          const full = blankCanvas(doc.width, doc.height);
          renderDoc(full.getContext("2d")!, {...doc, selection: null}, {background: true});
          const scale = Math.min(1, 250 / Math.max(doc.width, doc.height));
          const small = blankCanvas(Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)));
          small.getContext("2d")!.drawImage(full, 0, 0, small.width, small.height);
          const preview = small.toDataURL("image/png");
          if (active) setPreviews(current => ({...current, [record.id]: preview}));
        } catch { /* A broken thumbnail must not prevent opening the document. */ }
      }
    })();
    return () => { active = false; };
  }, [signature, workspaceId, projectId, call]);
  if (!recent.length) return null;
  return <section className="cf-editor-recent" aria-label="Recent documents">
    <SectionHeader title="Recent documents" />
    <div className="cf-editor-recent__grid">
      {recent.map(record => <MediaCard key={record.id} title={record.name}
        meta={<Meta>{record.kind === "recovery" ? "Draft · " : ""}{new Date(record.updated_at).toLocaleDateString()}</Meta>}
        viewLabel={`Open ${record.name}`} onView={() => {if (!busy) onOpen(record.id);}}
        media={previews[record.id] ? <img src={previews[record.id]} alt="" /> : <span className="cf-editor-recent__placeholder">{busy ? "Opening…" : "Open document"}</span>} />)}
    </div>
  </section>;
}
