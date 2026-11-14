-- Mark only this editor's existing layer backing files referenced by a document.
-- The bytes remain immutable and available by their authorized asset URL.
UPDATE assets a SET metadata=a.metadata || '{"editorDocumentBitmap":true}'::jsonb
WHERE a.media_type='layer' AND a.name='document-layer.png'
AND EXISTS (
  SELECT 1 FROM editor_documents d
  WHERE d.workspace_id=a.workspace_id AND d.project_id=a.project_id
  AND jsonb_path_exists(d.document,'$.** ? (@ == $key)',jsonb_build_object('key','asset:'||a.id::text))
);
