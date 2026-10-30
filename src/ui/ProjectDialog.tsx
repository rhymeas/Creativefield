import { useEffect, useState } from "react";
import { FolderPlus } from "lucide-react";
import { Button, Checkbox, Dialog, EmptyState, Notice, TextField } from "../ds";
import { projectHasPrompt, type ProjectsState } from "../library/projects";

export function ProjectDialog({
  open,
  projectId,
  projects,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  projectId: string | null;
  projects: ProjectsState;
  error: string | null;
  onClose: () => void;
  onSave: (name: string) => boolean;
  onDelete: () => boolean;
}) {
  const project = projectId ? projects.projects[projectId] : undefined;
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setConfirmDelete(false);
  }, [open, project?.name]);

  const save = () => {
    if (onSave(name)) onClose();
  };
  return (
    <Dialog
      open={open}
      title={project ? "Manage project" : "New project"}
      onClose={onClose}
      footer={
        <>
          {project && !confirmDelete && <Button variant="ghost" className="ds-project-dialog__delete" onClick={() => setConfirmDelete(true)}>Delete project</Button>}
          {confirmDelete ? (
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep project</Button>
              <Button variant="primary" onClick={() => { if (onDelete()) onClose(); }}>Delete collection</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={!name.trim()} onClick={save}>{project ? "Save name" : "Create project"}</Button>
            </>
          )}
        </>
      }
    >
      {confirmDelete ? (
        <Notice inline tone="info" title="Delete this project collection?">
          The ComfyUI jobs, media, favourites, Trash state and run records remain unchanged.
        </Notice>
      ) : (
        <TextField label="Project name" autoFocus value={name} maxLength={80} onChange={setName} onKeyDown={(event) => event.key === "Enter" && save()} />
      )}
      {error && <Notice inline tone="danger" title="Project change was not saved" details={error}>Nothing was changed. The name above is kept, so the same button saves it again.</Notice>}
    </Dialog>
  );
}

export function ProjectMembershipDialog({
  open,
  promptId,
  projects,
  error,
  onClose,
  onToggle,
  onNewProject,
}: {
  open: boolean;
  promptId: string | null;
  projects: ProjectsState;
  error: string | null;
  onClose: () => void;
  onToggle: (projectId: string, member: boolean) => void;
  onNewProject: () => void;
}) {
  const entries = Object.entries(projects.projects).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  return (
    <Dialog
      open={open}
      title="Add to projects"
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      {entries.length ? (
        <div className="ds-project-checks">
          {entries.map(([id, project]) => (
            <Checkbox key={id} checked={!!promptId && projectHasPrompt(projects, id, promptId)} disabled={!promptId} onChange={(v) => promptId && onToggle(id, v)}>
              {project.name}
            </Checkbox>
          ))}
        </div>
      ) : (
        <EmptyState title="No projects yet" text="Create a project, then add this job to it."/>
      )}
      <Button variant="secondary" onClick={onNewProject}><FolderPlus size={13} /> New project</Button>
      {error && <Notice inline tone="danger" title="Project change was not saved" details={error}>Nothing was changed. The name above is kept, so the same button saves it again.</Notice>}
    </Dialog>
  );
}
