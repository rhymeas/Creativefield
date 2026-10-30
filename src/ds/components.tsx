import { selectProblems } from "./problems";
import { useModalFocus } from "./useModalFocus";
import {linkMediaPlayback} from "./linked-playback";
import {
  Children,
  Fragment,
  isValidElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  forwardRef,
  useId,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
} from "react";
import {createPortal} from "react-dom";
import { AlertCircle, Trash2, ArrowLeftRight, ArrowUpRight, Repeat, Crop, Download, ImagePlus, LayoutGrid, Pencil, Grid3X3, Menu as GripIcon, Link2, Pause, Play, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, ImageIcon, Info, Maximize2, Music2, Plus, Search, Sparkles, Video, X } from "lucide-react";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

/* ── TopBar ─────────────────────────────────────────────────── */

export type MegaItem = { id: string; icon?: ReactNode; title: string; text?: string; badge?: { text: string; tone?: "accent" | "hot" | "soft" }; onSelect: () => void };
export type NavItem = { label: string; href: string; /** One entry that the product leads with: a thin brand-yellow ring. */ featured?: boolean; onSelect?: () => void; badge?: { text: string; tone?: "accent" | "hot" | "soft" }; menu?: { features: MegaItem[]; models: MegaItem[] }; /** A short list under the item (projects). The chosen entry is shown right after the label. */ dropdown?: { items: MegaItem[]; selectedId?: string; footer?: MegaItem }; suffix?: string };

export function TopBar({
  brand,
  items,
  secondary,
  current,
  end,
}: {
  brand: ReactNode;
  items: NavItem[];
  secondary?: NavItem[];
  current: string;
  end?: ReactNode;
}) {
  const navRef=useRef<HTMLElement>(null);
  useEffect(()=>{navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({block:"nearest",inline:"nearest"});},[current]);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!openMenu) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpenMenu(null);
    const away = (e: MouseEvent) => !(e.target as HTMLElement).closest?.("[data-megamenu]") && setOpenMenu(null);
    addEventListener("keydown", key);
    addEventListener("mousedown", away);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("mousedown", away);
    };
  }, [openMenu]);
  const link = (it: NavItem) =>
    it.dropdown ? (
      <span key={it.href} className="ds-megawrap" data-megamenu>
        <button type="button" className="ds-navlink" aria-haspopup="menu" aria-expanded={openMenu === it.href} aria-current={it.href === current ? "page" : undefined} onClick={() => setOpenMenu((o) => (o === it.href ? null : it.href))}>
          {it.label}
          {it.suffix && <span className="ds-navlink__suffix">{it.suffix}</span>}
          <ChevronDown size={12} aria-hidden />
        </button>
        {openMenu === it.href && (
          <div className="ds-navdrop" role="menu">
            {it.dropdown.items.map((i) => (
              <button key={i.id} type="button" role="menuitemradio" aria-checked={i.id === it.dropdown!.selectedId} className="ds-menu__item" onClick={() => { setOpenMenu(null); i.onSelect(); }}>
                <span className="ds-navdrop__check">{i.id === it.dropdown!.selectedId && <Check size={14} />}</span>
                {i.title}
              </button>
            ))}
            {it.dropdown.footer && (
              <button type="button" role="menuitem" className="ds-menu__item ds-navdrop__footer" onClick={() => { setOpenMenu(null); it.dropdown!.footer!.onSelect(); }}>
                {it.dropdown.footer.icon && <span className="ds-navdrop__check">{it.dropdown.footer.icon}</span>}
                {it.dropdown.footer.title}
              </button>
            )}
          </div>
        )}
      </span>
    ) : it.menu ? (
      <span key={it.href} className="ds-megawrap" data-megamenu>
        <button type="button" className="ds-navlink" aria-haspopup="true" aria-expanded={openMenu === it.href} aria-current={it.href === current ? "page" : undefined} onClick={() => setOpenMenu((o) => (o === it.href ? null : it.href))}>
          {it.label}
          <ChevronDown size={12} aria-hidden />
        </button>
        {openMenu === it.href && (
          <MegaMenu features={it.menu.features} models={it.menu.models} onPick={(i) => { setOpenMenu(null); i.onSelect(); }} />
        )}
      </span>
    ) : it.onSelect ? (
    <button key={it.href} type="button" className={cx("ds-navlink", it.featured && "ds-navlink--featured")} aria-current={it.href === current ? "page" : undefined} onClick={it.onSelect}>
      {it.label}
      {it.badge && <Badge tone={it.badge.tone}>{it.badge.text}</Badge>}
    </button>
    ) : (
    <a key={it.href} className={cx("ds-navlink", it.featured && "ds-navlink--featured")} href={it.href} aria-current={it.href === current ? "page" : undefined}>
      {it.label}
      {it.badge && <Badge tone={it.badge.tone}>{it.badge.text}</Badge>}
    </a>
    );
  return (
    <header className="ds-topbar">
      <span className="ds-topbar__brand">{brand}</span>
      <nav ref={navRef} className="ds-topbar__nav" aria-label="Main">
        {items.map(link)}
        {secondary && secondary.length > 0 && <span className="ds-topbar__sep" aria-hidden />}
        {secondary?.map(link)}
      </nav>
      <div className="ds-topbar__end">{end}</div>
    </header>
  );
}

/* MegaMenu: two columns under a top-bar item. Features on the left, models on the right. */
export function MegaMenu({ features, models, onPick }: { features: MegaItem[]; models: MegaItem[]; onPick: (i: MegaItem) => void }) {
  const column = (title: string, items: MegaItem[], compact = false) => (
    <div className={cx("ds-mega__col", compact && "ds-mega__col--compact")}>
      <span className="ds-mega__title">{title}</span>
      <div className="ds-mega__list">
      {items.map((i) => (
        <button key={i.id} type="button" className="ds-mega__item" onClick={() => onPick(i)}>
          <span className="ds-mega__icon">{i.icon}</span>
          <span className="ds-mega__copy">
            <span className="ds-mega__name">
              {i.title}
              {i.badge && <Badge tone={i.badge.tone}>{i.badge.text}</Badge>}
            </span>
            {i.text && <span className="ds-mega__text">{i.text}</span>}
          </span>
        </button>
      ))}
      </div>
    </div>
  );
  return (
    <div className="ds-mega" role="menu">
      {column("Features", features)}
      {column("Models", models, true)}
    </div>
  );
}

export function Badge({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "hot" | "soft" }) {
  return <span className={cx("ds-badge", tone !== "accent" && `ds-badge--${tone}`)}>{children}</span>;
}

export function Pill({ children, badge, quiet, size = "md", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { badge?: ReactNode; quiet?: boolean; size?: "md" | "lg" }) {
  return (
    <button className={cx("ds-pill", quiet && "ds-pill--quiet", size === "lg" && "ds-pill--lg")} {...rest}>
      {children}
      {badge}
    </button>
  );
}

export function Avatar({ initials }: { initials: string }) {
  return <span className="ds-avatar" aria-hidden>{initials}</span>;
}

/* ── Tabs ───────────────────────────────────────────────────── */

/** `label` is the accessible name; `short` is the text a narrow row shows instead (title keeps the full name). */
export type TabItem<T extends string> = { id: T; label: string; short?: string; icon?: ReactNode; disabled?: boolean };

export function UnderlineTabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="ds-utabs" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          className="ds-utab"
          aria-selected={t.id === value}
          aria-label={t.label}
          disabled={t.disabled}
          title={t.disabled ? "Coming in a later milestone" : t.short && t.short !== t.label ? t.label : undefined}
          onClick={() => onChange(t.id)}
        >
          <span className="ds-utab__label">{t.short ?? t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  quiet,
  block,
  large,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  quiet?: boolean;
  /** Fills the panel width in equal parts (a mode switch such as Motion transfer / Objects swap). */
  block?: boolean;
  /** Page-level filters: bigger targets and text. */
  large?: boolean;
}) {
  return (
    <div className={cx("ds-seg", quiet && "ds-seg--quiet", block && "ds-seg--block", large && "ds-seg--large")} role="tablist" aria-label={label}>
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          className="ds-seg__item"
          aria-selected={t.id === value}
          disabled={t.disabled}
          title={t.disabled ? "Coming in a later milestone" : undefined}
          onClick={() => onChange(t.id)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ── Ambient reel ───────────────────────────────────────────── */

const reelContext = createContext<string | undefined>(undefined);

/** One decorative loop for the current surface. It sits behind UI and never
    receives pointer input; panels, empty stages and the rail read it from here. */
export function AmbientReelProvider({ src, children }: { src?: string; children: ReactNode }) {
  return <reelContext.Provider value={src}>{children}</reelContext.Provider>;
}

/** True when the person asked their system for less motion: reels and hero clips stay still. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function AmbientReel({ src, className }: { src?: string; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = video.current;
    if (!el || !src || reduced) { el?.pause(); return; }
    if (typeof IntersectionObserver === "undefined") { void el.play().catch(() => {}); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void el.play().catch(() => {});
      else el.pause();
    }, { threshold: 0.05 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [src, reduced]);
  if (!src) return null;
  return (
    <span className={cx("ds-reel", className)} aria-hidden data-reduced={reduced || undefined}>
      <video ref={video} src={src} muted loop playsInline preload="metadata" tabIndex={-1} />
    </span>
  );
}

/* ── Panel ──────────────────────────────────────────────────── */

export function Panel({ header, children, footer, video }: { header?: ReactNode; children: ReactNode; footer?: ReactNode; video?: string }) {
  const reel = useContext(reelContext);
  const src = video ?? reel;
  return (
    <aside className="ds-panel" data-reel={src ? "" : undefined}>
      <AmbientReel src={src} />
      {header && <div className="ds-panel__header">{header}</div>}
      <div className="ds-panel__body">{children}</div>
      {footer && <div className="ds-panel__footer">{footer}</div>}
    </aside>
  );
}

/* ── Model card ─────────────────────────────────────────────── */

export function ModelCard({
  title,
  subtitle,
  image,
  video,
  onChange,
}: {
  title: string;
  subtitle: string;
  image?: string;
  video?: string;
  onChange?: () => void;
}) {
  const reel = useContext(reelContext);
  const clip = video ?? reel;
  return (
    <div
      className="ds-modelcard"
      data-clickable={onChange ? "" : undefined}
      data-reel={clip ? "" : undefined}
      role={onChange ? "button" : undefined}
      tabIndex={onChange ? 0 : undefined}
      aria-label={onChange ? `Change model: ${title}` : undefined}
      onClick={onChange}
      onKeyDown={onChange ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(); } } : undefined}
      style={image ? { backgroundImage: `url(${image})` } : undefined}
    >
      <AmbientReel src={clip} />
      {onChange && (
        <span className="ds-modelcard__action" aria-hidden>
          <GlassButton tabIndex={-1}>
            <Sparkles size={12} /> Change
          </GlassButton>
        </span>
      )}
      <p className="ds-modelcard__title">{title}</p>
      <p className="ds-modelcard__sub">{subtitle}</p>
    </div>
  );
}

export function GlassButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={cx("ds-glassbtn", props.className)} />;
}

/* ── Upload slot ────────────────────────────────────────────── */

/* Paste into upload slots. One document listener serves every slot on the page. A pasted file goes to the slot that
   has focus, else the one under the pointer, else the only slot that accepts it. Text fields keep normal paste. */
type PasteTarget = { accept: string; disabled: () => boolean; focused: () => boolean; hovered: () => boolean; onFile: (f: File) => void };
const pasteTargets = new Set<PasteTarget>();
let pasteListening = false;

/** Does a file match an input "accept" list (image/*, video/mp4, .png)? */
export function acceptsFile(accept: string, file: { type: string; name: string }) {
  if (!accept.trim()) return true;
  return accept.split(",").map((a) => a.trim().toLowerCase()).some((a) =>
    a.startsWith(".") ? file.name.toLowerCase().endsWith(a) : a.endsWith("/*") ? file.type.toLowerCase().startsWith(a.slice(0, -1)) : file.type.toLowerCase() === a,
  );
}

/** The first file on the clipboard, named so it can be told apart in the Library. */
export function clipboardFile(data: DataTransfer | null): File | null {
  const raw = data ? Array.from(data.files)[0] ?? Array.from(data.items).find((i) => i.kind === "file")?.getAsFile() ?? null : null;
  if (!raw) return null;
  if (raw.name && raw.name !== "image.png") return raw;
  const ext = raw.type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  return new File([raw], `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`, { type: raw.type });
}

const isTextField = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA") return true;
  return t.tagName === "INPUT" && !["file", "checkbox", "radio", "range", "button"].includes((t as HTMLInputElement).type);
};

function onDocumentPaste(e: ClipboardEvent) {
  if (e.defaultPrevented || isTextField(e.target)) return;
  const file = clipboardFile(e.clipboardData);
  if (!file) return;
  const open = Array.from(pasteTargets).filter((t) => !t.disabled() && acceptsFile(t.accept, file));
  const target = open.find((t) => t.focused()) ?? open.find((t) => t.hovered()) ?? (open.length === 1 ? open[0] : undefined);
  if (!target) return;
  e.preventDefault();
  target.onFile(file);
}

function usePasteTarget(accept: string, disabled: boolean, onFile: (f: File) => void) {
  const ref = useRef<HTMLLabelElement>(null);
  const hovered = useRef(false);
  const latest = useRef({ accept, disabled, onFile });
  latest.current = { accept, disabled, onFile };
  useEffect(() => {
    const target: PasteTarget = {
      get accept() { return latest.current.accept; },
      disabled: () => latest.current.disabled,
      focused: () => !!ref.current && ref.current.contains(document.activeElement),
      hovered: () => hovered.current,
      onFile: (f) => latest.current.onFile(f),
    };
    pasteTargets.add(target);
    if (!pasteListening) {
      document.addEventListener("paste", onDocumentPaste);
      pasteListening = true;
    }
    return () => { pasteTargets.delete(target); };
  }, []);
  return { ref, onPointerEnter: () => { hovered.current = true; }, onPointerLeave: () => { hovered.current = false; } };
}

export function UploadSlot({
  label,
  hint,
  accept,
  preview,
  kinds = ["image"],
  compact,
  tile,
  previewKind = "image",
  disabled = false,
  removeLabel,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  preview?: string | null;
  /** What `preview` points at. A video preview plays silently on a loop. */
  previewKind?: "image" | "video" | "audio";
  kinds?: Array<"image" | "video" | "audio">;
  /** A shorter slot, for a second image under the first. */
  compact?: boolean;
  /** A square slot meant to sit next to another one in an UploadPair. */
  tile?: boolean;
  disabled?: boolean;
  removeLabel?: string;
  onFile: (f: File | null) => void;
}) {
  const [drag, setDrag] = useState(false);
  const icons = { image: <ImageIcon size={14} />, video: <Video size={14} />, audio: <Music2 size={14} /> };
  const paste = usePasteTarget(accept, disabled || !!preview, (f) => onFile(f));

  if (preview) {
    return (
      <div className={cx("ds-upload ds-upload--filled", compact && "ds-upload--compact", tile && "ds-upload--tile",previewKind==="audio"&&"ds-upload--audio")}>
        {previewKind==="audio"?<audio src={preview} controls preload="metadata" aria-label={label}/>:previewKind === "video" ? (
          <video src={preview} muted loop autoPlay playsInline aria-label={label} />
        ) : (
          <img src={preview} alt={label} />
        )}
        <span className="ds-upload__clear">
          <GlassButton disabled={disabled} onClick={() => onFile(null)} aria-label={removeLabel??`Remove ${label.toLowerCase()}`}>
            <X size={12} /> Remove
          </GlassButton>
        </span>
      </div>
    );
  }

  return (
    <label
      ref={paste.ref}
      className={cx("ds-upload", compact && "ds-upload--compact", tile && "ds-upload--tile")}
      data-drag={drag}
      aria-disabled={disabled}
      title="Drop, paste (Ctrl+V) or choose a file"
      onPointerEnter={paste.onPointerEnter}
      onPointerLeave={paste.onPointerLeave}
      onDragOver={(e) => {
        if(disabled)return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if(disabled)return;
        onFile(e.dataTransfer.files?.[0] ?? null);
      }}
    >
      <div>
        <div className="ds-upload__icons">
          {kinds.map((k) => (
            <span key={k} className="ds-upload__icon">
              {icons[k]}
            </span>
          ))}
        </div>
        <p className="ds-upload__label">{label}</p>
        <p className="ds-upload__hint">{hint}</p>
      </div>
      <input disabled={disabled} type="file" accept={accept} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </label>
  );
}

/* ── Prompt field ───────────────────────────────────────────── */

/* UploadPair: two slots side by side (character + motion video). */
export function UploadPair({ children }: { children: ReactNode }) {
  return <div className="ds-uploadpair">{children}</div>;
}

/* PromptGroup: several related prompts in ONE card, divided by hairlines. */
export function PromptGroup({ children }: { children: ReactNode }) {
  return <div className="ds-promptgroup">{children}</div>;
}

export function PromptField({
  label,
  value,
  onChange,
  placeholder,
  tools,
  compact,
  labelOutside,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  tools?: ReactNode;
  compact?: boolean;
  labelOutside?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (disabled) setExpanded(false); }, [disabled]);
  // Grow with the text up to --prompt-max-lines, then scroll and offer the modal.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    // Measure again whenever the text or the column width changes, and once the fonts have loaded.
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      setOverflow(el.scrollHeight > el.clientHeight + 1 || el.scrollHeight >= parseFloat(getComputedStyle(el).maxHeight || "0") - 1);
    };
    fit();
    const watcher = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    watcher?.observe(el);
    void document.fonts?.ready.then(fit);
    return () => watcher?.disconnect();
  }, [value]);
  return (
    <div className={cx("ds-prompt", compact && "ds-prompt--compact", labelOutside && "ds-prompt--label-outside")}>
      <div className="ds-prompt__head">
        <label className="ds-prompt__label" htmlFor={id}>
          {label}
        </label>
        {overflow && (
          <IconButton disabled={disabled} label={`Open ${label} in a larger editor`} onClick={() => setExpanded(true)}>
            <Maximize2 size={14} />
          </IconButton>
        )}
      </div>
      <textarea disabled={disabled} ref={area} id={id} rows={1} value={value} placeholder={placeholder} onChange={(e) => { if (!disabled) onChange(e.target.value); }} />
      {tools && <div className="ds-prompt__tools">{tools}</div>}
      <Dialog open={expanded && !disabled} title={label} onClose={() => setExpanded(false)} footer={<Button variant="primary" onClick={() => setExpanded(false)}>Done</Button>}>
        <textarea disabled={disabled} className="ds-prompt__modal" autoFocus value={value} placeholder={placeholder} onChange={(e) => { if (!disabled) onChange(e.target.value); }} aria-label={label} />
      </Dialog>
    </div>
  );
}

/* ClampText: long text shows a few lines; "Show all" opens the full text in a modal. */
export function ClampText({ text, lines = 3, title }: { text: string; lines?: number; title?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines]);
  return (
    <>
      <p ref={ref} className="ds-clamp" style={{ WebkitLineClamp: lines }}>
        {text}
      </p>
      {clipped && (
        <button type="button" className="ds-clamp__more" onClick={() => setOpen(true)}>
          Show all
        </button>
      )}
      <Dialog open={open} title={title ?? "Full text"} onClose={() => setOpen(false)} footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
        <p className="ds-clamp__full">{text}</p>
      </Dialog>
    </>
  );
}

export function ToolChip({
  icon,
  children,
  pressed,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; pressed?: boolean }) {
  return (
    <button type="button" className="ds-toolchip" aria-pressed={pressed} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/* ── Popover menu (used by Row and ParamButton) ─────────────── */

export type Option<T extends string | number> = { value: T; label: string; note?: string };

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)&&!(e.target as Element)?.closest('[data-comfy-menu]')) close();
    };
    const onKey = (e: KeyboardEvent) => {if(e.key==="Escape"){close();ref.current?.querySelector<HTMLButtonElement>("button")?.focus();}};
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function Menu<T extends string | number>({
  title,
  options,
  value,
  onPick,
  placement = "top",
  anchor,
  onDismiss,
}: {
  title?: string;
  options: Option<T>[];
  value: T;
  onPick: (v: T) => void;
  placement?: "top" | "bottom";
  anchor:RefObject<HTMLDivElement>;
  onDismiss:()=>void;
}) {
  const menu=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState<{left:number;top:number;width:number;minWidth:number;maxWidth:string;maxHeight:number}|null>(null);
  useLayoutEffect(()=>{
    const update=()=>{
      if(!menu.current||!anchor.current)return;
      const box=anchor.current.getBoundingClientRect();
      // Resolve the scaled gutter from a computed length: the custom-property
      // text is calc(...), which parseFloat would truncate to its first px value.
      const gap=parseFloat(getComputedStyle(menu.current).rowGap)||0;
      // The menu hugs its options: at least as wide as the button, at most --menu-max-w (css max-width).
      const width=Math.min(Math.max(menu.current.offsetWidth,box.width),innerWidth-gap*2),height=menu.current.offsetHeight;
      const below=innerHeight-box.bottom-gap*2,above=box.top-gap*2,down=below>=height||below>=above;
      setPosition({left:Math.max(gap,Math.min(box.left,innerWidth-width-gap)),top:down?box.bottom+gap:Math.max(gap,box.top-height-gap),width,minWidth:Math.min(box.width,innerWidth-gap*2),maxWidth:`min(${innerWidth-gap*2}px, var(--menu-max-w))`,maxHeight:Math.max(0,down?below:above)});
    };
    update();addEventListener('resize',update);addEventListener('scroll',update,true);return()=>{removeEventListener('resize',update);removeEventListener('scroll',update,true);};
  },[anchor]);
  useEffect(()=>{if(position)(menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')??menu.current?.querySelector<HTMLButtonElement>("button"))?.focus();},[!!position]);
  return createPortal(
    <div ref={menu} className="ds-menu" role="menu" data-comfy-menu data-placement={placement} style={{position:"fixed",bottom:"auto",zIndex:100,overflowY:"auto",...position,visibility:position?"visible":"hidden"}} onKeyDown={e=>{
      if(e.key==="Tab"){e.preventDefault();onDismiss();anchor.current?.querySelector<HTMLButtonElement>('button')?.focus();return;}
      const buttons=Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if(!buttons.length||!["ArrowDown","ArrowUp","Home","End"].includes(e.key))return;e.preventDefault();
      buttons[e.key==="Home"?0:e.key==="End"?buttons.length-1:(index+(e.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length]?.focus();
    }}>
      {title && <div className="ds-menu__title">{title}</div>}
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="menuitemradio"
          aria-checked={o.value === value}
          className="ds-menu__item"
          onClick={() => onPick(o.value)}
        >
          <span style={{ width: 14, display: "inline-grid" }}>{o.value === value && <Check size={14} />}</span>
          {o.label}
          {o.note && <small>{o.note}</small>}
        </button>
      ))}
    </div>,document.body
  );
}

/* ── Param row (full width) ─────────────────────────────────── */

export function Row<T extends string | number>({
  label,
  display,
  icon,
  options,
  value,
  onChange,
  subtle,
  trailing,
  onClick,
  disabled,
}: {
  label: string;
  display?: ReactNode;
  icon?: ReactNode;
  options?: Option<T>[];
  value?: T;
  onChange?: (v: T) => void;
  subtle?: boolean;
  trailing?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const hasMenu = options && value !== undefined && onChange;
  return (
    <div className="ds-popwrap">
      <button
        type="button"
        className={cx("ds-row", subtle && "ds-row--subtle")}
        disabled={disabled}
        aria-haspopup={hasMenu ? "dialog" : undefined}
        aria-expanded={hasMenu ? open && !disabled : undefined}
        onClick={() => (hasMenu ? setOpen(true) : onClick?.())}
      >
        {subtle && icon}
        <span className="ds-row__text">
          <span className="ds-row__label">{label}</span>
          {!subtle && <span className="ds-row__value" title={typeof display === "string" ? display : undefined}>{display}</span>}
        </span>
        {trailing}
        <ChevronRight size={16} className="ds-row__chev" />
      </button>
      {hasMenu && <ChoiceDialog open={open && !disabled} title={label} options={options} value={value} onPick={(v) => { onChange(v); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

/* ── Param button (compact) ─────────────────────────────────── */

export function ParamButton<T extends string | number>({
  icon,
  context,
  label,
  options,
  value,
  onChange,
  title,
  disabled,
}: {
  icon: ReactNode;
  context?: ReactNode;
  label: ReactNode;
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  title: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const ref = useDismiss(open && !disabled, () => setOpen(false));
  return (
    <div className="ds-popwrap" ref={ref}>
      <button
        type="button"
        className={cx("ds-param", Boolean(context) && "ds-param--descriptive")}
        disabled={disabled}
        style={{ width: "100%" }}
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        aria-label={title}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {context ? <span className="ds-param__copy"><span className="ds-param__context">{context}</span><span className="ds-param__value">{label}</span></span> : label}
        {context && <ChevronDown className="ds-param__chev" size={14} aria-hidden/>}
      </button>
      {open && !disabled && (
        <Menu
          anchor={ref}
          onDismiss={()=>setOpen(false)}
          title={title}
          options={options}
          value={value}
          onPick={(v) => {
            onChange(v);
            setOpen(false);
            ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }}
        />
      )}
    </div>
  );
}

export function Params({ children }: { children: ReactNode }) {
  return <div className="ds-params">{children}</div>;
}

/* ── Generate button ────────────────────────────────────────── */

export function GenerateButton({
  busy,
  label,
  disabledReason,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  label?:ReactNode;
  disabledReason?:string;
}) {
  const button=(
    <button type="button" className="ds-generate" {...rest}>
      {busy ? <SparkleLoader size="sm" /> : <Sparkles size={14} />}
      {busy ? <ShimmerText>{label ?? "Generating"}</ShimmerText> : (label ?? "Generate")}
    </button>
  );
  // The main action says why it cannot run in plain view, never only on hover.
  const off=rest.disabled||rest["aria-disabled"]===true||rest["aria-disabled"]==="true";
  return off&&disabledReason&&!busy?<span className="ds-generate-wrap">{button}<span className="ds-generate__reason">{disabledReason}</span></span>:button;
}

/* ── Buttons ────────────────────────────────────────────────── */

export function Button({
  variant = "secondary",
  buttonRef,
  disabledReason,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost";buttonRef?:RefObject<HTMLButtonElement>;disabledReason?:string }) {
  const button=<button type="button" ref={buttonRef} {...rest} className={cx("ds-btn", `ds-btn--${variant}`, rest.className)} />;
  return rest.disabled&&disabledReason?<Tooltip content={disabledReason} focusable>{button}</Tooltip>:button;
}

/* LinkButton: a Button that is a link (downloads, external pages). Same looks, same hug-the-text width. */
export function LinkButton({ variant = "secondary", ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return <a {...rest} className={cx("ds-btn", `ds-btn--${variant}`, rest.className)} />;
}

/* MediaCard: one stored file in a grid (shared assets). Preview, name, facts, actions. */
export function MediaCard({ media, title, meta, actions, info, quiet, onView, viewLabel = "View media" }: { media: ReactNode; title?: ReactNode; meta?: ReactNode; actions?: ReactNode; /** Facts about the file, behind a small "i" on the image. */ info?: ReactNode; /** Media only: no text under it, actions appear on hover. */ quiet?: boolean; /** Makes the preview a full-area view action. */ onView?: () => void; viewLabel?: string }) {
  const preview=useSurfacePreview();
  return (
    <article className={cx("ds-mediacard", quiet && "ds-mediacard--quiet")}>
      <div className="ds-mediacard__media" ref={preview.ref}>
        {isValidElement(media)&&media.type==="audio"?media:<button type="button" className="ds-mediacard__view" aria-label={viewLabel} onClick={onView??preview.open}>{media}</button>}
        {info && <InfoDot>{info}</InfoDot>}
        {quiet && (actions||hasMediaNode(media)) && <div className="ds-mediacard__overlay">{actions??preview.actions}</div>}
      </div>
      {!quiet && (title || meta) && (
        <div className="ds-mediacard__body">
          {title && <span className="ds-mediacard__title" title={typeof title === "string" ? title : undefined}>{title}</span>}
          {meta}
        </div>
      )}
      {!quiet && actions && <div className="ds-mediacard__actions">{actions}</div>}
      {preview.viewer}
    </article>
  );
}

export function IconButton({ label, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} {...rest} className={cx("ds-iconbtn", rest.className)} />;
}

/* ── Canvas ─────────────────────────────────────────────────── */

export function Canvas({ toolbarStart, toolbarEnd, footer, children, workspace = false }: { toolbarStart?: ReactNode; toolbarEnd?: ReactNode; /** Quiet controls at the bottom right (History, How it works). */ footer?: ReactNode; children: ReactNode; workspace?: boolean }) {
  return (
    <section className={cx("ds-canvas", workspace && "ds-canvas--workspace")}>
      {(toolbarStart || toolbarEnd) && (
        <div className="ds-canvas__toolbar">
          {toolbarStart}
          <div className="ds-canvas__tools">{toolbarEnd}</div>
        </div>
      )}
      <div className="ds-canvas__body">{children}</div>
      {footer && <div className="ds-canvas__footer">{footer}</div>}
    </section>
  );
}

export function Slider(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="range" {...props} className={cx("ds-slider", props.className)} />;
}

/* ── History item ───────────────────────────────────────────── */

export function Tag({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="ds-tag">
      {icon}
      {children}
    </span>
  );
}

/* Meta: level-3 caption. Small, grey, parts joined by a middle dot. Falsy parts are skipped. */
export function Meta({ children, parts }: { children?: ReactNode; parts?: (ReactNode | false | null | undefined)[] }) {
  const shown = parts?.filter(Boolean);
  return (
    <span className="ds-meta">
      {shown
        ? shown.map((p, i) => (
            <span key={i} className="ds-meta__part">
              {p}
            </span>
          ))
        : children}
    </span>
  );
}

/* Rule: the hairline between two zones of a screen or panel. Screens never draw their own divider. */
export function Rule() {
  return <div className="ds-rule" role="separator" />;
}

/* Page layout. Screens are Page > Split/Block > Toolbar. Spacing comes from tokens, never from feature CSS.
   A page whose content fills the work area (a production split, a studio panel) says so with `fill`; the
   WorkspaceBar reads that one declaration instead of keeping its own list of screens (rule 35). */
export function Page({ children, narrow, fill, workspace }: { children: ReactNode; /** A centered reading column for list pages on wide screens. */ narrow?: boolean; /** The content fills the work area: no reading-column cap, and the bar above keeps the plain gutter. */ fill?: boolean; /** A canvas workspace uses the available area instead of a reading frame. */ workspace?: boolean }) {
  return <div className={cx("ds-page", narrow && !workspace && !fill && "ds-page--narrow", (fill || workspace) && "ds-page--fill", workspace && "ds-page--workspace")}>{children}</div>;
}
export function Split({ children }: { children: ReactNode }) {
  return <div className="ds-split">{children}</div>;
}
export function Block({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section className="ds-block" aria-label={label}>
      {children}
    </section>
  );
}
export function Toolbar({ children, className,end }: { children: ReactNode; className?: string;end?:ReactNode }) {
  return <div className={cx("ds-toolbar", className)}>{children}{end&&<span className="ds-toolbar__end">{end}</span>}</div>;
}

/* StatusText: a state as a dot and a word, not a chip. */
export function StatusText({ tone = "idle", children }: { tone?: "idle" | "active" | "ok" | "warn"; children: ReactNode }) {
  return (
    <span className="ds-status" data-tone={tone}>
      {children}
    </span>
  );
}

/* ShotList / ShotCard: ordered storyboard shots. The selected card shows its move buttons. */
export function ShotList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ol className="ds-shotlist" aria-label={label}>
      {children}
    </ol>
  );
}
export function ShotCard({
  index,
  title,
  meta,
  flag,
  selected,
  disabled,
  tools,
  onSelect,
  buttonRef,
}: {
  index: number;
  title: ReactNode;
  meta?: ReactNode;
  flag?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  tools?: ReactNode;
  onSelect: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <li className="ds-shot" data-selected={selected || undefined}>
      <span className="ds-shot__index" aria-hidden>
        {index}
      </span>
      <button type="button" className="ds-shot__main" ref={buttonRef} aria-current={selected ? "step" : undefined} disabled={disabled} onClick={onSelect}>
        <span className="ds-shot__title" title={typeof title === "string" ? title : undefined}>{title}</span>
        {meta}
        {flag}
      </button>
      {selected && tools && <span className="ds-shot__tools">{tools}</span>}
    </li>
  );
}
export function AddShotButton({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="ds-addshot" {...rest}>
      <Plus size={14} />
      {children}
    </button>
  );
}
/* Corkboard: a pinned, slightly rotated set of shot cards for planning.
   Cards are real buttons; nothing here is a rendered frame. */
export function Corkboard({ children, label = "Corkboard" }: { children: ReactNode; label?: string }) {
  const [density] = useDensity();
  return <ol className="ds-corkboard" aria-label={label} style={{ ["--cols" as string]: densityColumns(density, gridItemCount(children)) }}>{children}</ol>;
}

/* Collapsible: a quiet "more" section. */
export function Collapsible({ title, children, open, tone, arrow }: { title: ReactNode; children: ReactNode; open?: boolean; tone?: "strong"; /** "end" puts the arrow at the right edge, like a Row. */ arrow?: "end" }) {
  return (
    <details className={cx("ds-collapse", tone === "strong" && "ds-collapse--strong", arrow === "end" && "ds-collapse--end")} open={open}>
      <summary>
        <ChevronRight size={14} />
        {title}
      </summary>
      <div className="ds-collapse__body">{children}</div>
    </details>
  );
}

/* Result: title + facts, media (or a ResultSlot while there is none), actions. */
export function Result({ title, meta, media, actions }: { title: ReactNode; meta?: ReactNode; media: ReactNode; actions?: ReactNode }) {
  const preview=useSurfacePreview();
  return (
    <article className="ds-result">
      <div className="ds-result__head">
        <span className="ds-result__title">{title}</span>
        {meta}
      </div>
      <div ref={preview.ref} className="ds-result__media" onClick={event=>{if(event.currentTarget.contains(event.target as Node)&&!(event.target as Element).closest("button,a,audio"))preview.open();}}>{media}{hasMediaNode(media)&&<span className="ds-resulttile__actions">{preview.actions}</span>}</div>
      {actions && <div className="ds-result__actions">{actions}</div>}
      {preview.viewer}
    </article>
  );
}
export function ResultSlot({ status, children }: { status?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ds-slot">
      {status}
      {children && <p className="ds-slot__text">{children}</p>}
    </div>
  );
}

/* Switch + ToggleRow: an optional section ("Prompt", "Instructions (optional)"). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="ds-switch" onClick={() => onChange(!checked)}>
      <span className="ds-switch__knob" />
    </button>
  );
}
export function ToggleRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="ds-togglerow">
      <span className="ds-togglerow__label">
        {label}
        {hint && <span className="ds-togglerow__hint">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/* PanelSection: a labelled group inside a control panel. The label is level 2 (small, grey), never a title.
   Only the panel itself has a level-1 title. */
export function PanelSection({ label, meta, children }: { label: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="ds-psection" aria-label={label}>
      <div className="ds-psection__head">
        <span className="ds-psection__label">{label}</span>
        {meta}
      </div>
      {children}
    </section>
  );
}

/* PickerRow: choose one record (brand kit, product, board) with small icon actions beside it (new, edit).
   The picker is a Row; the actions are IconButtons. Controls never go into a SectionHeader. */
export function PickerRow({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ds-pickerrow">
      {children}
      {actions && <span className="ds-pickerrow__actions">{actions}</span>}
    </div>
  );
}

/* AddButton: the dashed "add another" row at the end of a list (shot, character, board). */
export function AddButton({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="ds-addshot" {...rest}>
      <Plus size={14} />
      {children}
    </button>
  );
}

/* ShotStrip / ShotTile: the storyboard timeline. Shots sit in one horizontally scrolling row, so ten shots
   or thirty read the same as three. The selected tile shows its move buttons. */
export function ShotStrip({ children, label, onAdd, addDisabled }: { children: ReactNode; label: string; onAdd?: () => void; addDisabled?: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = list.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdge((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = list.current;
    const watcher = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (el) watcher?.observe(el);
    return () => watcher?.disconnect();
  });
  const go = (dir: 1 | -1) => list.current?.scrollBy({ left: dir * (list.current.clientWidth * 0.8), behavior: "smooth" });
  return (
    <div className="ds-shotstrip-wrap">
      <ol className="ds-shotstrip" aria-label={label} ref={list} onScroll={measure}>
        {children}
        {onAdd && (
          <li className="ds-shotstrip__add">
            <button type="button" className="ds-addshot" disabled={addDisabled} onClick={onAdd}>
              <Plus size={14} />
              Add shot
            </button>
          </li>
        )}
      </ol>
      {edge.left && (
        <span className="ds-shotstrip__fade ds-shotstrip__fade--left">
          <IconButton label="Scroll shots left" onClick={() => go(-1)}>
            <ChevronLeft size={16} />
          </IconButton>
        </span>
      )}
      {edge.right && (
        <span className="ds-shotstrip__fade ds-shotstrip__fade--right">
          <IconButton label="Scroll shots right" onClick={() => go(1)}>
            <ChevronRight size={16} />
          </IconButton>
        </span>
      )}
    </div>
  );
}
export function ShotTile({
  index,
  title,
  meta,
  flag,
  selected,
  disabled,
  tools,
  image,
  onSelect,
  buttonRef,
}: {
  index: number;
  title: ReactNode;
  /** The shot's picture (rendered clip or input image). With it, the tile shows only the picture and its number. */
  image?: ReactNode;
  meta?: ReactNode;
  flag?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  tools?: ReactNode;
  onSelect: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  const preview=useSurfacePreview<HTMLLIElement>();
  return (
    <li ref={preview.ref} className="ds-shottile" data-selected={selected || undefined} data-image={image ? "" : undefined}>
      <button type="button" className="ds-shottile__main" ref={buttonRef} aria-current={selected ? "step" : undefined} disabled={disabled} onClick={()=>{onSelect();if(image)preview.open();}} title={typeof title === "string" ? title : undefined}>
        {image && <span className="ds-shottile__art">{image}</span>}
        <span className="ds-shottile__head">
          <span className="ds-shot__index" aria-hidden>
            {index}
          </span>
          {flag}
        </span>
        {!image && (
          <span className="ds-shottile__title">
            {title}
          </span>
        )}
        {!image && meta}
      </button>
      {selected && tools && <span className="ds-shottile__tools">{tools}</span>}
      {hasMediaNode(image)&&<span className="ds-shottile__preview">{preview.actions}</span>}
      {preview.viewer}
    </li>
  );
}

/* Small square reference images. Interactive thumbs are checkable; read-only thumbs stay quiet. */
export function ThumbGrid({ children, label, compact }: { children: ReactNode; label: string; /** Small tiles in one scrolling row (a quick pick under a field). */ compact?: boolean }) {
  const [density] = useDensity();
  return <div className={cx("ds-thumbgrid", compact && "ds-thumbgrid--compact")} role="group" aria-label={label} style={{ ["--cols" as string]: densityColumns(density, gridItemCount(children)) }}>{children}</div>;
}

/* InfoDot: a small "i" on an image. Hover or click shows what the image is (name, source, ids) over the image,
   so the grid itself stays quiet. The parent must be position: relative. */
function InfoDot({ children }: { children: ReactNode }) {
  const [open,setOpen]=useState(false);
  return <><Tooltip className="ds-media-info" content={children}><IconButton label="Details" onClick={()=>setOpen(true)}><Info size={14}/></IconButton></Tooltip><Dialog open={open} title="Media details" onClose={()=>setOpen(false)} footer={<Button onClick={()=>setOpen(false)}>Close</Button>}>{children}</Dialog></>;
}

/** A viewport-clamped tooltip, outside scrolling panels and image clipping. */
export function Tooltip({content,children,className,focusable=false}:{content:ReactNode;children:ReactNode;className?:string;focusable?:boolean}){
  const ref=useRef<HTMLSpanElement>(null),id=useId();
  const [position,setPosition]=useState<{left:number;top:number}|null>(null);
  const show=()=>{const r=ref.current?.getBoundingClientRect();if(r)setPosition({left:Math.max(12,Math.min(r.left,window.innerWidth-292)),top:Math.min(r.bottom+8,window.innerHeight-180)});};
  useEffect(()=>{if(!position)return;const close=()=>setPosition(null);addEventListener("scroll",close,true);addEventListener("resize",close);return()=>{removeEventListener("scroll",close,true);removeEventListener("resize",close);};},[!!position]);
  return <span ref={ref} className={cx("ds-tooltip-anchor",className)} tabIndex={focusable?0:undefined} aria-describedby={position?id:undefined} onMouseEnter={show} onMouseLeave={()=>setPosition(null)} onFocus={show} onBlur={()=>setPosition(null)} onClick={event=>{event.stopPropagation();show();}} onKeyDown={event=>{if(event.key==="Escape")setPosition(null);}}>{children}{position&&createPortal(<div id={id} role="tooltip" className="ds-tooltip" style={position}>{content}</div>,document.body)}</span>;
}

export function Thumb({ src, label, info, selected, disabled, onSelect, onPreview, onRemove, video, audio, dragData }: {
  src?: string; label: string; info?: ReactNode; selected?: boolean; disabled?: boolean; onSelect?: () => void;
  onPreview?:()=>void;
  /** Take this reference out of the tray. Shown as a hover action, like the other tile tools. */
  onRemove?:()=>void;
  /** The source is a video: show its first frame. */
  video?: boolean;
  /** Audio assets use a sound glyph, not an image thumbnail. */
  audio?:boolean;
  /** Drag the tile onto a media field to reuse it ({ type, value } go on the drag). */
  dragData?: { type: string; value: string };
}) {
  const preview=useSurfacePreview();
  const face = (
    <>
      {audio?<Music2 size={18}/>:src ? (video ? <video src={src} muted playsInline preload="metadata" /> : <img src={src} alt="" loading="lazy" />) : <ImageIcon size={18} />}
      {onSelect && <span className="ds-thumb__check">{selected && <Check size={12} />}</span>}
    </>
  );
  return (
    <div ref={preview.ref} className="ds-thumb" data-selected={selected || undefined}>
      {onSelect ? (
        <button type="button" className="ds-thumb__art" role={onPreview?undefined:"checkbox"} aria-checked={onPreview?undefined:!!selected} aria-current={onPreview&&selected?"true":undefined} aria-label={onPreview&&selected?`${label} (selected)`:label} title={label} disabled={disabled} onClick={onPreview??onSelect}
          draggable={!!dragData} onDragStart={dragData ? (e) => { e.dataTransfer.setData(dragData.type, dragData.value); e.dataTransfer.effectAllowed = "copy"; } : undefined}>
          {face}
        </button>
      ) : (
        <span className="ds-thumb__art" title={label}>
          {face}
        </span>
      )}
      {info && <InfoDot>{info}</InfoDot>}
      {(onPreview||onRemove)&&<span className="ds-thumb__actions">{onRemove&&<IconButton label={`Remove ${label}`} onClick={onRemove}><X size={14}/></IconButton>}{onPreview&&<IconButton label="Full view" onClick={onPreview}><Maximize2 size={14}/></IconButton>}{onPreview&&preview.canEdit&&<IconButton label="Edit media" onClick={preview.edit}><Pencil size={14}/></IconButton>}</span>}
      {preview.viewer}
    </div>
  );
}

/* ReferenceTray: many references into one run (people, products, clothes). The strip scrolls, the count says
   how many of the cap are used, and the add tile is gone once the cap is reached. */
export function ReferenceTray({ label, max, children, onAdd }: {
  label: string;
  /** The most references one run accepts. */
  max: number;
  children: ReactNode;
  onAdd: () => void;
}) {
  const count = gridItemCount(children);
  return (
    <div className="ds-reftray" role="group" aria-label={label}>
      <div className="ds-reftray__head">
        <span className="ds-reftray__label">{label}</span>
        <Meta>{`${count} of ${max}`}</Meta>
      </div>
      <div className="ds-reftray__row">
        {children}
        {count < max && (
          <span className="ds-reftray__add">
            <AddButton onClick={onAdd}>Add</AddButton>
          </span>
        )}
      </div>
    </div>
  );
}

/* UploadTile: a file that is being sent. The thumbnail shows at once; the state sits over it (sparkle and a
   shimmering word, no bar). It becomes a normal MediaCard when the upload is done. */
export function UploadTile({ src, kind = "image", state, onRetry, onDismiss }: { src?: string; kind?: "image" | "video" | "audio"; state: "uploading" | "failed"; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <div className="ds-uploadtile" data-state={state}>
      <div className="ds-uploadtile__media">
        {src && kind === "image" ? <img src={src} alt="" /> : src && kind === "video" ? <video src={src} muted playsInline /> : kind === "audio" ? <span className="ds-uploadtile__glyph"><Music2 size={16} /></span> : null}
      </div>
      <div className="ds-uploadtile__veil">
        {state === "uploading" ? (
          <>
            <SparkleLoader size="sm" />
            <ShimmerText>Uploading</ShimmerText>
          </>
        ) : (
          <>
            <StatusText tone="warn">Upload failed</StatusText>
            <span className="ds-uploadtile__actions">
              {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
              {onDismiss && <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* ModeTabs: the mode switch of a screen (Storyboard, Create, Trim). Large, centered under the top bar, and the active
   mode is unmistakable: white text and a glowing accent underline. One per screen. */
export function ModeTabs<T extends string>({ items, value, onChange, label }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="ds-modetabs" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" className="ds-modetab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* InfoButton: technical facts (versions, contracts, limits) stay out of the layout and open on request. */
export type ShortcutItem = { keys: string[]; label: string };
export type ShortcutGroup = { title: string; items: ShortcutItem[] };

/* ShortcutSheet: a grouped key reference. Each key is a chip; "+" inside a key joins a combo (Ctrl+Shift+Z). */
export function ShortcutSheet({ groups, note }: { groups: ShortcutGroup[]; note?: string }) {
  return (
    <div className="ds-shortcuts">
      {groups.map((g) => (
        <section key={g.title} className="ds-shortcuts__group">
          <h3 className="ds-shortcuts__title">{g.title}</h3>
          <dl className="ds-shortcuts__list">
            {g.items.map((item) => (
              <div key={item.label} className="ds-shortcuts__row">
                <dt className="ds-shortcuts__keys">
                  {item.keys.map((combo) => (
                    <span key={combo} className="ds-shortcuts__combo">
                      {combo.split("+").map((part, i) => (
                        <span key={i} className="ds-shortcuts__chip-wrap">
                          {i > 0 && <span className="ds-shortcuts__plus">+</span>}
                          <kbd className="ds-shortcuts__key">{part}</kbd>
                        </span>
                      ))}
                    </span>
                  ))}
                </dt>
                <dd className="ds-shortcuts__label">{item.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {note && <p className="ds-shortcuts__note">{note}</p>}
    </div>
  );
}

export function InfoButton({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={`About ${title}`} onClick={() => setOpen(true)}>
        <Info size={14} />
      </IconButton>
      <Dialog open={open} title={title} onClose={() => setOpen(false)} footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
        {children}
      </Dialog>
    </>
  );
}

/* SliderField: a labelled slider with its value on the right. The one way to set a number on a range. */
export function SliderField({ label, value, min, max, step = 1, unit = "", onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="ds-sliderfield">
      <label htmlFor={id} className="ds-sliderfield__label">{label}</label>
      <span className="ds-sliderfield__value">{Math.round(value * 100) / 100}{unit}</span>
      <Slider id={id} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

/* Swatches: pick one color from a short row. */
export function Swatches({ label, colors, value, onChange }: { label: string; colors: string[]; value: string; onChange: (color: string) => void }) {
  return (
    <div className="ds-swatches" role="radiogroup" aria-label={label}>
      {colors.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} aria-label={c} className="ds-swatch" data-selected={c === value || undefined} style={{ ["--swatch" as string]: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/* LayerRow: one layer in a stack. Select it, show or hide it, reorder it. */
export function LayerRow({ name, thumb, mask, maskOff, maskActive, onMask, onMaskMenu, visible, selected, depth, linked, onSelect, onOpen, onToggle, dragging, dropTarget, onDragStart, onDragOver, onDrop, onDragEnd }: {
  name: string;
  depth?: number;
  thumb?: ReactNode;
  /** The layer mask, shown as a second thumbnail. Click edits it, Shift-click switches it off, right-click opens its menu. */
  mask?: ReactNode;
  maskOff?: boolean;
  maskActive?: boolean;
  onMask?: (e: React.MouseEvent) => void;
  onMaskMenu?: (e: React.MouseEvent) => void;
  visible: boolean;
  selected?: boolean;
  /** Linked layers move together; the row shows a chain. */
  linked?: boolean;
  /** Click; the event tells Shift (add to the selection) and Alt (clip to the layer below). */
  onSelect: (e: React.MouseEvent) => void;
  /** Double-click: open the layer's settings (style or adjustment). */
  onOpen?: () => void;
  onToggle: () => void;
  /** Drag anywhere on the row to reorder. A click without movement still selects. */
  dragging?: boolean;
  /** This row is the current drop target: a line shows where the dragged layer lands. */
  dropTarget?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  return (
    <li
      className="ds-layerrow"
      data-depth={depth || undefined}
      data-selected={selected || undefined}
      data-hidden={!visible || undefined}
      data-dragging={dragging || undefined}
      data-drop-target={dropTarget || undefined}
      draggable={Boolean(onDragStart) || undefined}
      onDragStart={onDragStart ? (e) => { e.dataTransfer.setData("text/plain", name); e.dataTransfer.effectAllowed = "move"; onDragStart(); } : undefined}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver ? (e) => { e.preventDefault(); onDragOver(); } : undefined}
      onDrop={onDrop ? (e) => { e.preventDefault(); onDrop(); } : undefined}
    >
      <button type="button" className="ds-layerrow__eye" aria-label={visible ? `Hide ${name}` : `Show ${name}`} aria-pressed={visible} onClick={onToggle}>
        {visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button type="button" className="ds-layerrow__main" aria-pressed={selected} onClick={onSelect} onDoubleClick={onOpen}>
        <span className="ds-layerrow__thumb">{thumb}</span>
        <span className="ds-layerrow__name">{name}</span>
        {linked && <Link2 size={14} className="ds-layerrow__link" aria-label="Linked" />}
      </button>
      {mask && (
        <button type="button" className="ds-layerrow__thumb ds-layerrow__mask" aria-label={`Mask of ${name}`} aria-pressed={maskActive} data-off={maskOff || undefined} data-active={maskActive || undefined}
          title="Click: edit the mask · Shift-click: mask on/off · Right-click: more" onClick={onMask} onContextMenu={(e) => { e.preventDefault(); onMaskMenu?.(e); }}>
          {mask}
        </button>
      )}
      {onDragStart && (
        <span className="ds-layerrow__grip" aria-hidden title="Drag to reorder">
          <GripIcon size={14} />
        </span>
      )}
    </li>
  );
}

/* LayerList: the stack, top layer first. */
export function LayerList({ label, alt, children }: { label: string; /** Alt held: a click clips the layer to the one below. */ alt?: boolean; children: ReactNode }) {
  return <ul className="ds-layerlist" aria-label={label} data-alt={alt || undefined}>{children}</ul>;
}

/* ToolRail: a vertical palette of icon tools beside the work surface. One is active; groups are split by "separator". */
export function ToolRail<T extends string>({ label, value, onChange, items }: { label: string; value: T; onChange: (id: T) => void; items: Array<{ id: T; label: string; icon: ReactNode } | "separator"> }) {
  return (
    <div className="ds-toolrail" role="radiogroup" aria-label={label}>
      {items.map((item, i) =>
        item === "separator" ? (
          <span key={`s${i}`} className="ds-toolrail__sep" aria-hidden />
        ) : (
          <button key={item.id} type="button" role="radio" aria-checked={item.id === value} aria-label={item.label} title={item.label} className="ds-toolrail__tool" data-selected={item.id === value || undefined} onClick={() => onChange(item.id)}>
            {item.icon}
          </button>
        ),
      )}
    </div>
  );
}

/* Stage: the work surface of an editor. Checkerboard behind transparent pixels, picture centered and never stretched.
   An optional rail of tools sits to its left. */
export const Stage = forwardRef<HTMLDivElement, { children: ReactNode; rail?: ReactNode; /** A chip at the bottom of the surface (what the AI is doing). */ status?: ReactNode } & React.HTMLAttributes<HTMLDivElement>>(function Stage({ children, rail, status, ...surfaceProps }, ref) {
  return (
    <div className="ds-stagebox">
      {rail}
      <div {...surfaceProps} className="ds-stage" ref={ref}>{children}{status && <div className="ds-stage__status">{status}</div>}</div>
    </div>
  );
});

/* ColorPicker: saturation/brightness square, hue slider and hex field. The one way to choose any color. */
const hexToHsv = (hex: string) => {
  const n = hex.replace("#", "");
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n.padEnd(6, "0");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max };
};
const hsvToHex = (h: number, s: number, v: number) => {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return `#${[f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
};

export function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const last = useRef(value);
  useEffect(() => {
    if (value.toLowerCase() !== last.current.toLowerCase()) {
      last.current = value;
      setHsv(hexToHsv(value));
    }
  }, [value]);
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const { width: w, height: h } = c;
    ctx.fillStyle = hsvToHex(hsv.h, 1, 1);
    ctx.fillRect(0, 0, w, h);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, "#fff");
    white.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, h);
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, "rgba(0,0,0,0)");
    black.addColorStop(1, "#000");
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, h);
  }, [hsv.h]);
  const commit = (next: { h: number; s: number; v: number }) => {
    setHsv(next);
    const hex = hsvToHex(next.h, next.s, next.v);
    last.current = hex;
    onChange(hex);
  };
  const pick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === "pointermove" && e.buttons !== 1) return;
    const r = e.currentTarget.getBoundingClientRect();
    commit({ h: hsv.h, s: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), v: 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
  };
  return (
    <div className="ds-colorpicker" role="group" aria-label={label}>
      <div className="ds-colorpicker__sv">
        <canvas ref={canvas} width={240} height={140} aria-label={`${label}: saturation and brightness`} onPointerDown={(e) => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } pick(e); }} onPointerMove={pick} />
        <span className="ds-colorpicker__knob" style={{ ["--kx" as string]: hsv.s * 100, ["--ky" as string]: (1 - hsv.v) * 100 }} />
      </div>
      <SliderField label="Hue" unit="°" min={0} max={360} value={Math.round(hsv.h)} onChange={(h) => commit({ ...hsv, h })} />
      <TextField label="Hex" value={value} onChange={(v) => /^#?[0-9a-fA-F]{6}$/.test(v) && commit(hexToHsv(v))} />
    </div>
  );
}

/* ForegroundBackground: the two working colors. Click one to edit it, swap with the arrows. */
export function ForegroundBackground({ fg, bg, editing, onEdit, onSwap }: { fg: string; bg: string; editing: "fg" | "bg"; onEdit: (which: "fg" | "bg") => void; onSwap: () => void }) {
  return (
    <div className="ds-fgbg">
      <button type="button" className="ds-fgbg__swatch ds-fgbg__swatch--bg" data-selected={editing === "bg" || undefined} aria-label="Background color" style={{ ["--swatch" as string]: bg }} onClick={() => onEdit("bg")} />
      <button type="button" className="ds-fgbg__swatch ds-fgbg__swatch--fg" data-selected={editing === "fg" || undefined} aria-label="Foreground color" style={{ ["--swatch" as string]: fg }} onClick={() => onEdit("fg")} />
      <IconButton label="Swap colors" onClick={onSwap}><ArrowLeftRight size={14} /></IconButton>
    </div>
  );
}

/* TabbedPanel: a tool panel with tabs on top (Layers, Channels), an optional ≡ menu at the end of the tab strip and an
   action bar at the bottom. The active tab is joined to the body, like a folder tab. */
export function TabbedPanel<T extends string>({ label, tabs, value, onChange, menu, footer, children }: {
  label: string;
  tabs: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  menu?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ds-tabpanel" aria-label={label}>
      <div className="ds-tabpanel__tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className="ds-tabpanel__tab" data-selected={t.id === value || undefined} onClick={() => onChange(t.id)}>
            {t.label}
          </button>
        ))}
        {menu && <div className="ds-tabpanel__menu">{menu}</div>}
      </div>
      <div className="ds-tabpanel__body" role="tabpanel">{children}</div>
      {footer && <div className="ds-tabpanel__footer">{footer}</div>}
    </section>
  );
}

/* Dropdown: a short list that hangs directly under its button (left- or right-aligned to it). */
function Dropdown({ anchor, align, items, value, onPick, onDismiss }: {
  anchor: RefObject<HTMLElement>;
  align: "left" | "right";
  items: Array<{ id: string; label: string }>;
  value?: string;
  onPick: (id: string, alt: boolean) => void;
  onDismiss: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number; minWidth: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setPos(align === "left" ? { top: r.bottom + 4, left: r.left, minWidth: r.width } : { top: r.bottom + 4, right: innerWidth - r.right, minWidth: 0 });
    };
    place();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => { removeEventListener("resize", place); removeEventListener("scroll", place, true); };
  }, [anchor, align]);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || anchor.current?.contains(t)) return;
      onDismiss();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onDismiss();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [anchor, onDismiss]);
  return createPortal(
    <div ref={menu} className="ds-menu ds-dropdown" role="menu" style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? "auto", right: pos?.right ?? "auto", bottom: "auto", minWidth: pos?.minWidth ?? 0, zIndex: 100 }}>
      {items.map((i) => (
        <button key={i.id} type="button" role={value === undefined ? "menuitem" : "menuitemradio"} aria-checked={value === undefined ? undefined : i.id === value} className="ds-menu__item" onClick={(e) => onPick(i.id, e.altKey)}>
          {value !== undefined && <span className="ds-dropdown__check">{i.id === value && <Check size={12} />}</span>}
          {i.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/* InlineSelect: a compact dropdown that shows only its value (Normal ▾). For dense panels. */
export function InlineSelect<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  return (
    <div className="ds-inline ds-inline--select" ref={ref}>
      <button type="button" className="ds-inline__select" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {current?.label ?? value}
      </button>
      <ChevronDown size={12} className="ds-inline__chev" aria-hidden />
      {open && <Dropdown anchor={ref} align="left" value={value} items={options.map((o) => ({ id: o.value, label: o.label }))} onPick={(id) => { onChange(id as T); setOpen(false); }} onDismiss={() => setOpen(false)} />}
    </div>
  );
}

/* InlineSlider: "Opacity: 100% ▾". Type the number, or open the slider with the arrow. */
export function InlineSlider({ label, value, min = 0, max = 100, unit = "%", onChange, disabled }: { label: string; value: number; min?: number; max?: number; unit?: string; onChange: (v: number) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="ds-inline ds-inline--slider" ref={ref}>
      <span className="ds-inline__label">{label}:</span>
      <span className="ds-inline__field">
        <input className="ds-inline__input" type="number" aria-label={label} min={min} max={max} value={value} disabled={disabled} onChange={(e) => e.target.value !== "" && onChange(clamp(Number(e.target.value)))} />
        <span className="ds-inline__unit">{unit}</span>
        <button type="button" className="ds-inline__open" aria-label={`Adjust ${label.toLowerCase()}`} aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
          <ChevronDown size={14} />
        </button>
      </span>
      {open && (
        <div className="ds-inline__pop">
          <Slider aria-label={label} min={min} max={max} value={value} onChange={(e) => onChange(clamp(Number(e.target.value)))} />
        </div>
      )}
    </div>
  );
}

/* LabeledRow: "Lock:" followed by its controls, on one line. */
export function LabeledRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ds-labeledrow" role="group" aria-label={label}>
      <span className="ds-labeledrow__label">{label}:</span>
      {children}
    </div>
  );
}

/* ActionBar: the row of icon actions at the bottom of a tool panel, spread over its width. */
export function ActionBar({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ds-actionbar" role="toolbar" aria-label={label}>{children}</div>;
}

/* MenuButton: an icon (≡) that opens a short list of commands right under it. Commands learn whether Alt was held. */
export function MenuButton({ label, icon, items }: { label: string; icon: ReactNode; items: Array<{ id: string; label: string; onSelect: (alt: boolean) => void; disabled?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const alt = useRef(false);
  const ref = useRef<HTMLSpanElement>(null);
  const enabled = items.filter((i) => !i.disabled);
  return (
    <span className="ds-popbtn" ref={ref}>
      <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { alt.current = e.altKey; setOpen((o) => !o); }}>{icon}</IconButton>
      {open && <Dropdown anchor={ref} align="right" items={enabled} onPick={(id, altNow) => { setOpen(false); enabled.find((i) => i.id === id)?.onSelect(alt.current || altNow); }} onDismiss={() => setOpen(false)} />}
    </span>
  );
}

/* FloatingPanel: a small window that floats over the editor, opens next to the side column and can be dragged by
   its title bar to wherever it is handy. It keeps its place while the editor is open. */
export function FloatingPanel({ open, title, onClose, anchor, placement = "left", children }: { open: boolean; title: string; onClose: () => void; anchor?: RefObject<HTMLElement>; placement?: "left" | "right"; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || pos) return;
    const w = box.current?.offsetWidth ?? 280;
    const h = box.current?.offsetHeight ?? 360;
    const a = anchor?.current?.getBoundingClientRect();
    if (!a) {
      setPos({ x: Math.max(8, innerWidth / 2 - w / 2), y: 120 });
      return;
    }
    const x = placement === "right" ? a.right + 16 : a.left - w - 16;
    const y = placement === "right" ? a.bottom - h : a.top + 40;
    setPos({ x: Math.min(Math.max(8, x), Math.max(8, innerWidth - w - 8)), y: Math.min(Math.max(8, y), Math.max(8, innerHeight - h - 8)) });
  }, [open, pos, anchor, placement]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div ref={box} className="ds-float" role="dialog" aria-label={title} style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      <div
        className="ds-float__head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const r = box.current!.getBoundingClientRect();
          drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPos({ x: Math.min(innerWidth - 60, Math.max(0, e.clientX - drag.current.dx)), y: Math.min(innerHeight - 40, Math.max(0, e.clientY - drag.current.dy)) });
        }}
        onPointerUp={() => { drag.current = null; }}
      >
        <GripIcon size={12} />
        <span className="ds-float__title">{title}</span>
        <IconButton label="Close" onClick={onClose}><X size={14} /></IconButton>
      </div>
      <div className="ds-float__body">{children}</div>
    </div>,
    document.body,
  );
}

/* FxIcon: the "fx" mark for layer styles (no icon set has one). */
export function FxIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <text x="3" y="18" fontSize="17" fontStyle="italic" fontFamily="Georgia, serif" fill="currentColor">fx</text>
    </svg>
  );
}

/* ResultGrid follows the shared Items per row setting and uses the actual item count when a batch is smaller. */
export function ResultGrid({ count, aspect, label, children }: { count: number; /** width / height; 0 = use each image's own shape */ aspect: number; label: string; children: ReactNode }) {
  const [density] = useDensity();
  const columns = densityColumns(density, count);
  return (
    <div className="ds-resultgrid" role="list" aria-label={label} data-count={count} data-masonry={aspect > 0 ? undefined : ""} style={{ ["--cols" as string]: columns, ["--tile-aspect" as string]: aspect > 0 ? aspect : "auto" }}>
      {children}
    </div>
  );
}

/* ResultTile: one image in a ResultGrid, or its place while it is being made (pass a status instead of children). */
export function ResultTile({ children, status, caption, actions, onOpen, develop }: { children?: ReactNode; status?: ReactNode; /** A small, user-facing label on the picture (Final, Shot 2). */ caption?: ReactNode; /** Icon actions in the corner, shown on hover (View, Edit). */ actions?: ReactNode; /** Double-click opens the picture. */ onOpen?: () => void; /** A real in-progress frame. active=false freezes a failed/cancelled preview. progress is 0..1, never invented. */ develop?: { src?: string; label: ReactNode; detail?: ReactNode; progress?: number; active?: boolean; /** Stops the job; shown as a small Cancel while it works. */ onCancel?: () => void; cancelling?: boolean } }) {
  const preview=useSurfacePreview();
  const open=onOpen??preview.open;
  return (
    <div ref={preview.ref} className="ds-resulttile" role="listitem" tabIndex={!develop&&children ? 0 : undefined} data-empty={(!develop && !children) || undefined} data-develop={develop ? "" : undefined} onClick={event=>{if(!develop&&!(event.target as Element).closest('button,a,input'))open();}}
      onKeyDown={!develop&&children ? event => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault(); open();
        }
      } : undefined}>
      {develop ? (
        <span
          className="ds-resulttile__develop"
          aria-busy={develop.active !== false}
          data-terminal={develop.active === false ? "" : undefined}
          style={{ ["--develop-blur" as string]: `${Math.max(2, 18 - Math.min(1, Math.max(0, develop.progress ?? 0)) * 16)}px` }}
        >
          {develop.src ? <img className="ds-resulttile__preview" src={develop.src} alt="" /> : <span className="ds-resulttile__skeleton"><Skeleton height={10} /><Skeleton width="72%" height={10} /></span>}
          <span className="ds-resulttile__developtext">
            {develop.active === false ? <StatusText tone="warn">{develop.label}</StatusText> : <ShimmerText>{develop.label}</ShimmerText>}
            {develop.detail && <span className="ds-resulttile__developdetail">{develop.detail}</span>}
            {develop.onCancel && develop.active !== false && <Button variant="ghost" disabled={develop.cancelling} onClick={event => { event.stopPropagation(); develop.onCancel!(); }}>{develop.cancelling ? "Cancelling…" : "Cancel"}</Button>}
          </span>
        </span>
      ) : children ?? <span className="ds-resulttile__status">{status}</span>}
      {caption && <span className="ds-resulttile__caption">{caption}</span>}
      {!develop&&(actions||hasMediaNode(children))&&<span className="ds-resulttile__actions">{actions??<><IconButton label="Full view" onClick={open}><Maximize2 size={14}/></IconButton>{preview.canEdit&&<IconButton label="Edit media" onClick={preview.edit}><Pencil size={14}/></IconButton>}</>}</span>}
      {preview.viewer}
    </div>
  );
}

export type ContactSheetItem = { src?: string; label?: string };

/* ContactSheet: a clean printable sheet for a batch, then a PNG download. */
export function ContactSheet({ items, title = "Contact sheet", fileName = "contact-sheet.png", caption }: { items: ContactSheetItem[]; title?: string; fileName?: string; caption?: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let cancelled = false;
    setReady(false);
    setMissing(0);
    const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const page = css("--surface-page", "#0f1113");
    const control = css("--surface-control", "#1b1d1f");
    const line = css("--line-soft", "rgba(255,255,255,.08)");
    const text = css("--text-primary", "#f5f5f5");
    const meta = css("--text-meta", "rgba(255,255,255,.42)");
    const accent = css("--accent", "#4da3ff");
    const width = 1200;
    const columns = 3;
    const gap = 22;
    const pad = 40;
    const tileWidth = (width - pad * 2 - gap * (columns - 1)) / columns;
    const tileHeight = Math.round(tileWidth * 9 / 16);
    const header = 64;
    const rows = Math.max(1, Math.ceil(items.length / columns));
    const height = header + rows * (tileHeight + 44) + pad;
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = page;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = text;
    ctx.font = "600 18px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(title.toUpperCase(), pad, 39);
    ctx.fillStyle = meta;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.fillText(`${items.length} FRAME${items.length === 1 ? "" : "S"}`, width - pad, 39);
    ctx.textAlign = "left";
    const hole = (x: number, y: number) => {
      ctx.fillStyle = control;
      ctx.beginPath();
      ctx.roundRect(x, y, 18, 9, 2);
      ctx.fill();
    };
    for (let x = pad; x < width - pad; x += 34) { hole(x, 16); hole(x, height - 25); }
    const pending = items.filter((item) => item.src).length;
    let settled = 0;
    const settle = () => {
      settled += 1;
      if (settled === pending) setReady(true);
    };
    const drawTile = (item: ContactSheetItem, index: number) => {
      const x = pad + (index % columns) * (tileWidth + gap);
      const y = header + Math.floor(index / columns) * (tileHeight + 44);
      ctx.fillStyle = control;
      ctx.beginPath();
      ctx.roundRect(x, y, tileWidth, tileHeight, 12);
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (item.label) {
        ctx.fillStyle = meta;
        ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(item.label, x, y + tileHeight + 21);
      }
      if (!item.src) {
        ctx.fillStyle = meta;
        ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.fillText("NO PREVIEW", x + tileWidth / 2, y + tileHeight / 2 + 4);
        ctx.textAlign = "left";
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        // Contact sheets preserve the entire frame; aspect differences are letterboxed.
        const scale = Math.min(tileWidth / image.width, tileHeight / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, tileWidth, tileHeight, 12);
        ctx.clip();
        ctx.drawImage(image, x + (tileWidth - w) / 2, y + (tileHeight - h) / 2, w, h);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, tileWidth - 1, tileHeight - 1, 12);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.28;
        ctx.stroke();
        ctx.restore();
        settle();
      };
      image.onerror = () => {
        if (cancelled) return;
        setMissing((count) => count + 1);
        ctx.fillStyle = meta;
        ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.fillText("PREVIEW UNAVAILABLE", x + tileWidth / 2, y + tileHeight / 2 + 4);
        ctx.textAlign = "left";
        settle();
      };
      image.src = item.src;
    };
    items.forEach(drawTile);
    if (!pending) setReady(true);
    return () => { cancelled = true; };
  }, [items, title]);

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = fileName;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoking synchronously can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    }, "image/png");
  };

  return (
    <div className="ds-contactsheet">
      <canvas ref={canvasRef} role="img" aria-label={`${title} with ${items.length} frames`} />
      <div className="ds-contactsheet__actions">
        <div className="ds-contactsheet__status">
          {caption && <Meta>{caption}</Meta>}
          {missing > 0 && <Meta>{missing} preview{missing === 1 ? "" : "s"} unavailable; empty slots are preserved.</Meta>}
        </div>
        <Button variant="secondary" onClick={download} disabled={!items.length || !ready}>
          {ready ? "Download PNG" : "Preparing PNG"}
        </Button>
      </div>
    </div>
  );
}

/* Flashlight: a browser-only light guide over a source image. It records where the
   light should come from and which temperature is picked; it never fakes a render. */
export function Flashlight({ src, alt = "", direction, temperature, temperatures, onDirectionChange, onTemperatureChange, label = "Live light guide" }: {
  src?: string;
  alt?: string;
  direction: string;
  temperature: string;
  temperatures: Array<{ id: string; label: string }>;
  onDirectionChange: (direction: string) => void;
  onTemperatureChange: (id: string) => void;
  label?: string;
}) {
  const [pos, setPos] = useState({ x: 0.5, y: 0.55 });
  const [dragging, setDragging] = useState(false);
  const describe = (x: number, y: number) => {
    const side = x < 0.4 ? "left" : x > 0.6 ? "right" : "";
    const depth = y < 0.36 ? "behind" : y > 0.64 ? "front" : "";
    if (side && depth) return `from the ${depth}-${side}`;
    if (side) return `from the ${side}`;
    if (depth) return `from the ${depth}`;
    return "from the front";
  };
  const move = (x: number, y: number) => {
    const next = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    setPos(next);
    onDirectionChange(describe(next.x, next.y));
  };
  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    move((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
  };
  const stepTemperature = (delta: number) => {
    const index = Math.max(0, temperatures.findIndex((item) => item.id === temperature));
    const next = temperatures[(index + delta + temperatures.length) % temperatures.length];
    if (next) onTemperatureChange(next.id);
  };
  return (
    <div className="ds-flashlight">
      <div
        className="ds-flashlight__stage"
        role="application"
        tabIndex={0}
        aria-label={`${label}. ${direction}, ${temperature}. Arrow keys move the light, Page Up and Page Down change temperature.`}
        data-dragging={dragging || undefined}
        data-temperature={temperature}
        style={{ ["--light-x" as string]: `${pos.x * 100}%`, ["--light-y" as string]: `${pos.y * 100}%` }}
        onPointerDown={(event) => { setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); point(event); }}
        onPointerMove={(event) => { if (dragging) point(event); }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
        onPointerCancel={() => setDragging(false)}
        onWheel={(event) => { event.preventDefault(); stepTemperature(event.deltaY > 0 ? 1 : -1); }}
        onKeyDown={(event) => {
          const nudge = 0.08;
          if (event.key.startsWith("Arrow")) {
            event.preventDefault();
            move(pos.x + (event.key === "ArrowRight" ? nudge : event.key === "ArrowLeft" ? -nudge : 0), pos.y + (event.key === "ArrowDown" ? nudge : event.key === "ArrowUp" ? -nudge : 0));
          } else if (event.key === "PageUp" || event.key === "PageDown") {
            event.preventDefault();
            stepTemperature(event.key === "PageUp" ? -1 : 1);
          }
        }}
      >
        {src && <img className="ds-flashlight__image" src={src} alt={alt} draggable={false} />}
        <span className="ds-flashlight__glow" aria-hidden />
        <span className="ds-flashlight__pin" aria-hidden>KEY</span>
        <span className="ds-flashlight__label">{label}</span>
      </div>
      <div className="ds-flashlight__readout">
        <Meta parts={[direction, temperatures.find((item) => item.id === temperature)?.label ?? temperature]} />
        <Meta>Move the light · wheel or Page Up/Down changes temperature</Meta>
      </div>
    </div>
  );
}

/* GestureStage: records a pointer path over a frame and snaps it to one of the
   camera moves the caller offers. Wheel snaps to zoom. It only reports a real
   chosen move; it never pretends a preview was rendered. */
export function GestureStage({ src, alt = "", value, moves, onChange, label = "Camera gesture", instruction, disabled = false }: {
  src?: string;
  alt?: string;
  value: string;
  moves: Array<{ id: string; label: string }>;
  onChange: (id: string) => void;
  label?: string;
  instruction?: string;
  disabled?: boolean;
}) {
  const [path, setPath] = useState<Array<{ x: number; y: number }>>([]);
  const pathRef = useRef<Array<{ x: number; y: number }>>([]);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<{ x: number; y: number } | null>(null);
  const chosen = moves.find((move) => move.id === value);
  const has = (id: string) => moves.some((move) => move.id === id);
  const pointAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
  };
  const pickPath = (points: Array<{ x: number; y: number }>) => {
    if (points.length < 2) return;
    const start = points[0], end = points[points.length - 1];
    const dx = end.x - start.x, dy = end.y - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.06) return;
    const id = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "pan-right" : "pan-left") : (dy > 0 ? "pan-down" : "pan-up");
    if (has(id)) onChange(id);
  };
  const move = (id: string) => {
    if (!id) onChange("");
    else if (has(id)) onChange(id);
  };
  useEffect(() => {
    if (!playing || path.length < 2) return;
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setPlayhead(path[Math.min(index, path.length - 1)]);
      if (index >= path.length - 1) {
        window.clearInterval(timer);
        setPlaying(false);
      }
    }, 36);
    return () => window.clearInterval(timer);
  }, [playing, path]);
  const download = () => {
    const blob = new Blob([JSON.stringify({ move: value || null, path, recordedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `camera-gesture-${value || "none"}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return (
    <div className="ds-gesture">
      <div
        className="ds-gesture__stage"
        role="application"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-label={`${label}. ${chosen ? chosen.label : "No move yet"}. Drag across the frame, or use the arrow keys. Wheel or Page Up and Page Down selects zoom.`}
        data-dragging={dragging || undefined}
        data-disabled={disabled || undefined}
        onPointerDown={(event) => { if (disabled || event.button !== 0) return; setDragging(true); setPlaying(false); event.currentTarget.setPointerCapture(event.pointerId); pathRef.current = [pointAt(event)]; setPath(pathRef.current); }}
        onPointerMove={(event) => { if (disabled || !dragging) return; pathRef.current = [...pathRef.current, pointAt(event)]; setPath(pathRef.current); }}
        onPointerUp={(event) => {
          if (disabled) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
          pathRef.current = [...pathRef.current, pointAt(event)];
          setPath(pathRef.current);
          pickPath(pathRef.current);
        }}
        onPointerCancel={() => setDragging(false)}
        onWheel={(event) => { if (disabled) return; event.preventDefault(); move(event.deltaY < 0 ? "zoom-in" : "zoom-out"); }}
        onKeyDown={(event) => {
          if (disabled) return;
          const byKey: Record<string, string> = { ArrowLeft: "pan-left", ArrowRight: "pan-right", ArrowUp: "pan-up", ArrowDown: "pan-down", PageUp: "zoom-in", PageDown: "zoom-out" };
          const id = byKey[event.key];
          if (id) { event.preventDefault(); move(id); }
        }}
      >
        {src ? <img className="ds-gesture__image" src={src} alt={alt} draggable={false} /> : <span className="ds-gesture__empty" aria-hidden />}
        <svg className="ds-gesture__path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {path.length > 1 && <polyline points={path.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")} />}
        </svg>
        {playhead && <span className="ds-gesture__dot" aria-hidden style={{ left: `${playhead.x * 100}%`, top: `${playhead.y * 100}%` }} />}
        <span className="ds-gesture__label">{label}</span>
        <span className="ds-gesture__hint" aria-hidden>DRAG THE FRAME</span>
      </div>
      <div className="ds-gesture__readout">
        <Meta parts={[chosen ? `You did: ${chosen.label}` : "No move yet", instruction]} />
        <div className="ds-gesture__actions">
          <Button variant="secondary" disabled={disabled || path.length < 2} onClick={() => { setPlayhead(path[0] ?? null); setPlaying(true); }}>Replay gesture</Button>
          <Button variant="secondary" disabled={disabled || path.length < 2} onClick={download}>Download gesture</Button>
          {value && <Button variant="ghost" disabled={disabled} onClick={() => { onChange(""); setPath([]); pathRef.current = []; setPlayhead(null); }}>Clear move</Button>}
        </div>
      </div>
    </div>
  );
}

/* InbetweenRail: the frames between a first and last still. Empty slots are
   explicitly ghost frames; real extracted frames fill them after a run. */
export function InbetweenRail({ first, last, frames, images, imageFrameIndices, label = "Inbetween frames", caption }: {
  first?: string;
  last?: string;
  frames: number;
  images?: string[];
  imageFrameIndices?: number[];
  label?: string;
  caption?: string;
}) {
  const shown = Math.max(1, Math.min(8, frames));
  const real = images ?? [];
  return (
    <div className="ds-inbetween">
      <div className="ds-inbetween__rail" role="list" aria-label={label}>
        {Array.from({ length: shown }, (_, index) => (
          <span className="ds-inbetween__slot" role="listitem" key={index} data-real={real[index] ? true : undefined}>
            {real[index] ? <img src={real[index]} alt={imageFrameIndices?.[index]!==undefined?`Output frame ${imageFrameIndices[index]}`:`Inbetween sample ${index + 1}`} /> : <span className="ds-inbetween__ghost" aria-hidden>{index + 1}</span>}
          </span>
        ))}
      </div>
      <div className="ds-inbetween__bookends">
        {first ? <img src={first} alt="First frame" /> : <span className="ds-inbetween__missing">First frame missing</span>}
        <Meta>{frames} frame{frames === 1 ? "" : "s"} · {real.length ? `${real.length} extracted` : "ghost plan"}</Meta>
        {last ? <img src={last} alt="Last frame" /> : <span className="ds-inbetween__missing">Last frame missing</span>}
      </div>
      {caption && <Meta>{caption}</Meta>}
    </div>
  );
}

export function CastCard({ name, portrait, meta, stats, selected = false, onActivate, draggable = false, onDragStart, actions }: {
  name: string;
  portrait?: string;
  meta?: ReactNode;
  stats?: ReactNode;
  selected?: boolean;
  onActivate?: () => void;
  draggable?: boolean;
  onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
  actions?: ReactNode;
}) {
  const body = <>
    <span className="ds-castcard__portrait">{portrait ? <img src={portrait} alt=""/> : <span aria-hidden>{name.trim().slice(0, 2).toUpperCase() || "CA"}</span>}</span>
    <span className="ds-castcard__copy"><strong>{name}</strong>{meta && <Meta>{meta}</Meta>}{stats && <Meta>{stats}</Meta>}</span>
  </>;
  const shared = { className: "ds-castcard", "data-selected": selected || undefined, draggable, onDragStart };
  return <article {...shared}>
    {onActivate ? <button type="button" className="ds-castcard__main" onClick={onActivate}>{body}</button> : <div className="ds-castcard__main">{body}</div>}
    {actions && <span className="ds-castcard__actions">{actions}</span>}
  </article>;
}

export function DropTarget({ label, hint, children, disabled = false, busy, onDrop }: {
  label: string;
  hint?: string;
  children?: ReactNode;
  disabled?: boolean;
  /** While something is being uploaded into this box, the box says so itself, in these words. */
  busy?: string;
  onDrop: (payload: string) => void;
}) {
  const [over, setOver] = useState(false);
  function drop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    if (disabled) return;
    const payload = event.dataTransfer.getData("text/plain");
    if (payload) onDrop(payload);
  }
  return <div
    className="ds-droptarget"
    data-over={over || undefined}
    data-disabled={disabled || undefined}
    onDragEnter={event => { event.preventDefault(); if (!disabled) setOver(true); }}
    onDragOver={event => { if (!disabled) event.preventDefault(); }}
    onDragLeave={event => { if (event.currentTarget === event.target) setOver(false); }}
    onDrop={drop}
  >
    {children}
    {label && <span className="ds-droptarget__label">{label}</span>}
    {hint && <Meta>{hint}</Meta>}
    {busy && <span className="ds-droptarget__busy" role="status"><ShimmerText>{busy}</ShimmerText></span>}
  </div>;
}

export function ScoutReel({ items, value, onSelect, label = "Scout destinations", caption, disabled = false }: {
  items: Array<{ id: string; label: string; src?: string }>;
  value: string;
  onSelect: (id: string) => void;
  label?: string;
  caption?: ReactNode;
  disabled?: boolean;
}) {
  const index = Math.max(0, items.findIndex(item => item.id === value));
  function step(delta: number) {
    if (disabled || !items.length) return;
    const next = (index + delta + items.length) % items.length;
    onSelect(items[next].id);
  }
  return <div className="ds-scout" data-disabled={disabled || undefined}>
    <div className="ds-scout__head"><span className="ds-scout__label">{label}</span><Meta>{items.length ? `${index + 1} / ${items.length}` : "No destinations"}</Meta></div>
    <div className="ds-scout__rail" role="list" aria-label={label} tabIndex={disabled ? -1 : 0} onWheel={event => { if (disabled) return; event.preventDefault(); step(event.deltaY > 0 ? 1 : -1); }} onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); step(1); } if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); } }}>
      {items.map(item => <button type="button" role="listitem" key={item.id} className="ds-scout__item" aria-pressed={item.id === value} disabled={disabled} onClick={() => onSelect(item.id)}>
        <span className="ds-scout__frame">{item.src ? <img src={item.src} alt=""/> : <span className="ds-scout__ghost" aria-hidden/>}</span>
        <span>{item.label}</span>
      </button>)}
    </div>
    {caption && <Meta>{caption}</Meta>}
  </div>;
}

export function PerformanceMirror({ driving, result, label = "Performance mirror", caption }: {
  driving?: string;
  result?: string;
  label?: string;
  caption?: ReactNode;
}) {
  const left=useRef<HTMLVideoElement>(null),right=useRef<HTMLVideoElement>(null),[open,setOpen]=useState(false),[playbackHint,setPlaybackHint]=useState("");
  useEffect(()=>{setPlaybackHint("");if(driving&&result&&left.current&&right.current)return linkMediaPlayback(left.current,right.current,setPlaybackHint);},[driving,result]);
  const openComparison=()=>{left.current?.pause();right.current?.pause();setOpen(true);};
  return <div className="ds-mirror">
    <div className="ds-mirror__head"><span>{label}</span>{driving&&result&&<Tooltip content={playbackHint||"Linked play, pause and seek. Compare the same elapsed time up to the shorter clip's end; open full view to unlink."}><IconButton label="Open linked comparison" onClick={openComparison}><Link2 size={14}/></IconButton></Tooltip>}</div>
    <div className="ds-mirror__pair">
      <figure><figcaption>Driving performance</figcaption>{driving ? <ResultTile onOpen={result?openComparison:undefined}><video ref={left} src={driving} controls muted playsInline preload="metadata"/></ResultTile> : <span className="ds-mirror__missing">No driving clip</span>}</figure>
      <figure><figcaption>Result</figcaption>{result ? <ResultTile onOpen={driving?openComparison:undefined}><video ref={right} src={result} controls playsInline preload="metadata"/></ResultTile> : <span className="ds-mirror__missing">No result yet</span>}</figure>
    </div>
    {caption && <Meta>{caption}</Meta>}
    <MediaViewer open={open} src={result??""} name="Performance comparison" mediaType="video" compare={driving?{src:driving,name:"Driving performance"}:undefined} onClose={()=>setOpen(false)}/>
  </div>;
}

export function TrackSticker({ left, top, width, height, label, selected = false, onSelect }: {
  left: number;
  top: number;
  width: number;
  height: number;
  label: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const box = <><span className="ds-track__box" style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}/><span className="ds-track__pin" style={{ left: `${left}%`, top: `${top}%` }}>{label}</span></>;
  return onSelect ? <button type="button" className="ds-track" data-selected={selected || undefined} aria-pressed={selected} onClick={onSelect}>{box}</button> : <div className="ds-track">{box}</div>;
}

export function Teleprompter({ lines, current = 0, label = "Teleprompter" }: { lines: string[]; current?: number; label?: string }) {
  return <div className="ds-teleprompter" aria-label={label}>
    {lines.length ? lines.map((line, index) => <p key={`${index}-${line}`} data-current={index === current || undefined}>{line}</p>) : <Meta>No lines yet.</Meta>}
  </div>;
}

export function LevelMeter({ level, label = "Microphone level" }: { level: number; label?: string }) {
  const value = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  return <div className="ds-level" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
    <span className="ds-level__bars" aria-hidden>{Array.from({ length: 16 }, (_, index) => <i key={index} data-on={index / 16 < value || undefined}/>)}</span>
    <Meta>{Math.round(value * 100)}%</Meta>
  </div>;
}

/* DockPanel: one box in an editor's side column. It folds away with the arrow and moves up or down by dragging its grip,
   like Photoshop panels. The title can be text or a row of DockTabs. */
export function DockPanel({ id, label, title, end, footer, collapsed, onToggle, children }: {
  id?: string;
  label?: string;
  title: ReactNode;
  end?: ReactNode;
  footer?: ReactNode;
  collapsed?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className="ds-dock"
      data-dock-id={id}
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      data-collapsed={collapsed || undefined}
    >
      <header className="ds-dock__head">
        {id && (
          <button type="button" className="ds-dock__grip" aria-label={`Move ${label ?? title} panel`} title="Drag to reorder · Alt+↑ / Alt+↓">
            <GripIcon size={14} />
          </button>
        )}
        <div className="ds-dock__title">{title}</div>
        {end && <div className="ds-dock__end">{end}</div>}
        <button type="button" className="ds-dock__toggle" aria-expanded={!collapsed} aria-label={collapsed ? "Expand panel" : "Collapse panel"} onClick={onToggle}>
          <ChevronDown size={16} />
        </button>
      </header>
      {!collapsed && <div className="ds-dock__body">{children}</div>}
      {!collapsed && footer && <div className="ds-dock__footer">{footer}</div>}
    </section>
  );
}

/* DockTabs: tabs that sit in a DockPanel title (Layers | Channels). */
export function DockTabs<T extends string>({ label, tabs, value, onChange }: { label: string; tabs: Array<{ id: T; label: string }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="ds-docktabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className="ds-docktab" data-selected={t.id === value || undefined} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

/* PopoverButton: an icon that opens a small floating panel to its left, with an arrow pointing back at the icon.
   For settings that should not take room in the column (Adjustments). */
export function PopoverButton({ label, icon, title, children }: { label: string; icon: ReactNode; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number; arrow: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      /* Sit left of the whole panel the button is in, pointing at the button. */
      const edge = (anchor.current?.closest(".ds-dock, .ds-panel") as HTMLElement | null)?.getBoundingClientRect().left ?? a.left;
      const h = pop.current?.offsetHeight ?? 0;
      const mid = a.top + a.height / 2;
      const top = Math.max(8, Math.min(innerHeight - h - 8, mid - 32));
      setPos({ top, right: innerWidth - edge + 12, arrow: mid - top });
    };
    place();
    const raf = requestAnimationFrame(place);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", place); removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || anchor.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <span className="ds-popbtn" ref={anchor}>
      <IconButton label={label} aria-expanded={open} aria-pressed={open} onClick={() => setOpen((o) => !o)}>{icon}</IconButton>
      {open && createPortal(
        <div ref={pop} className="ds-sidepop" role="dialog" aria-label={title} style={{ top: pos?.top ?? -9999, right: pos?.right ?? 0, ["--arrow-y" as string]: `${pos?.arrow ?? 24}px` }}>
          <div className="ds-sidepop__head">
            <span className="ds-sidepop__title">{title}</span>
            <IconButton label="Close" onClick={() => setOpen(false)}><X size={14} /></IconButton>
          </div>
          <div className="ds-sidepop__body">{children}</div>
        </div>,
        document.body,
      )}
    </span>
  );
}

/* AppRail: the app's sections as a vertical icon rail on the left (Runway/ComfyUI style). One click switches section;
   the name shows as a tooltip. The current section is tinted with the accent. */
export type RailItem = { id: string; label: string; icon: ReactNode; href: string };
export function AppRail({ brand, label, items, current }: { brand?: ReactNode; label: string; items: RailItem[]; current: string }) {
  const reel = useContext(reelContext);
  return (
    <nav className="ds-rail" aria-label={label} data-reel={reel ? "" : undefined}>
      <AmbientReel src={reel} />
      {brand && <div className="ds-rail__brand">{brand}</div>}
      {items.map((it) => (
        <a key={it.id} href={it.href} className="ds-rail__item" aria-label={it.label} data-tip={it.label} aria-current={it.id === current ? "page" : undefined}>
          {it.icon}
        </a>
      ))}
    </nav>
  );
}

/* WorkspaceBar: mode tabs for the current section (accent underline on the active one) and the page's
   end slot. The section is named by the rail and the page, never repeated here. */
export function WorkspaceBar<T extends string>({ tabs, end, density, info }: {
  /** Show the items-per-row control at the end of the bar. */
  density?: boolean;
  info?: ReactNode;
  tabs?: { label: string; value: T; items: Array<{ id: T; label: string }>; onChange: (id: T) => void };
  end?: ReactNode;
}) {
  return (
    <header className="ds-wsbar">
      {tabs && tabs.items.length > 1 && (
        <div className="ds-wsbar__tabs" role="tablist" aria-label={tabs.label}>
          {tabs.items.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === tabs.value} className="ds-wsbar__tab" data-selected={t.id === tabs.value || undefined} onClick={() => tabs.onChange(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {(end || density || info) && <div className="ds-wsbar__end">{end}{density && <DensityControl />}{info}</div>}
    </header>
  );
}

/* PillMenu: a small chip that shows a choice (the project) and opens a short list under it. */
export function PillMenu({ icon, label, items, value, footer, onPick }: { icon?: ReactNode; label: string; items: Array<{ id: string; label: string }>; value?: string; footer?: { id: string; label: string }; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const all = footer ? [...items, footer] : items;
  return (
    <span className="ds-popbtn" ref={ref}>
      <button type="button" className="ds-pillmenu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon}
        <span className="ds-pillmenu__label">{label}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && <Dropdown anchor={ref} align="right" value={value ?? ""} items={all} onPick={(id) => { setOpen(false); onPick(id); }} onDismiss={() => setOpen(false)} />}
    </span>
  );
}

/* TrimTimeline: cut a clip on a timeline. A preview that loops the chosen range, a film strip of real frames, two
   handles for in and out (frame-exact; arrows move one frame, Shift ten) and a playhead you place by clicking. */
export function TrimTimeline({ src, frames, start, end, onChange, label = "Trim range" }: { src: string; frames: number; start: number; end: number; onChange: (start: number, end: number) => void; label?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [strip, setStrip] = useState<string[]>([]);
  const [fps, setFps] = useState(0);
  const [head, setHead] = useState(start);
  const [playing, setPlaying] = useState(false);
  const total = Math.max(1, frames);
  const pct = (f: number) => `${(Math.min(total, Math.max(0, f)) / total) * 100}%`;
  const seconds = (f: number) => (fps ? f / fps : 0);

  /* Film strip: decode a dozen frames once per clip. */
  useEffect(() => {
    let alive = true;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    const canvas = document.createElement("canvas");
    const out: string[] = [];
    const onData = async () => {
      const d = v.duration;
      if (!d || !isFinite(d)) return;
      canvas.width = 160;
      canvas.height = Math.max(1, Math.round((160 * v.videoHeight) / Math.max(1, v.videoWidth)));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const n = 12;
      for (let i = 0; i < n && alive; i++) {
        await new Promise<void>((resolve) => { v.onseeked = () => resolve(); v.currentTime = Math.min(d - 0.01, ((i + 0.5) * d) / n); });
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        out.push(canvas.toDataURL("image/jpeg", 0.6));
        if (alive) setStrip([...out]);
      }
    };
    v.addEventListener("loadeddata", () => void onData(), { once: true });
    return () => { alive = false; v.removeAttribute("src"); v.load(); };
  }, [src]);

  const seek = (f: number) => {
    setHead(f);
    const v = video.current;
    if (v && fps) v.currentTime = seconds(f);
  };
  const frameAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total);
  };
  const dragHandle = (which: "start" | "end") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: PointerEvent) => {
      const f = frameAt(ev.clientX);
      if (which === "start") { const s2 = Math.min(f, end - 1); onChange(s2, end); seek(s2); }
      else { const e2 = Math.max(f, start + 1); onChange(start, e2); seek(Math.max(start, e2 - 1)); }
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const keyHandle = (which: "start" | "end") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (!d) return;
    e.preventDefault();
    if (which === "start") { const s2 = Math.min(end - 1, Math.max(0, start + d)); onChange(s2, end); seek(s2); }
    else { const e2 = Math.max(start + 1, Math.min(total, end + d)); onChange(start, e2); seek(e2 - 1); }
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (head < start || head >= end - 1) seek(start);
      void v.play();
    } else v.pause();
  };
  return (
    <div className="ds-trim" role="group" aria-label={label}>
      <div className="ds-trim__stage">
        <video
          ref={video}
          src={src}
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (d && isFinite(d)) setFps(total / d); }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (!fps) return;
            const f = Math.floor(v.currentTime * fps + 0.001);
            if (!v.paused && f >= end) { v.currentTime = seconds(start); setHead(start); return; }
            setHead(f);
          }}
        />
      </div>
      <div className="ds-trim__bar">
        <IconButton label={playing ? "Pause" : "Play the range"} onClick={toggle}>{playing ? <Pause size={16} /> : <Play size={16} />}</IconButton>
        <span className="ds-trim__time">{seconds(head).toFixed(2)}s</span>
        <span className="ds-trim__range-readout">In {start} · Out {end} · {end - start} frames{fps ? ` · ${seconds(end - start).toFixed(2)}s` : ""}</span>
      </div>
      <div className="ds-trim__track" ref={track} onPointerDown={(e) => seek(Math.min(total - 1, frameAt(e.clientX)))}>
        <div className="ds-trim__strip" aria-hidden>
          {strip.map((u, i) => <img key={i} src={u} alt="" />)}
        </div>
        <div className="ds-trim__shade" style={{ left: 0, width: pct(start) }} aria-hidden />
        <div className="ds-trim__shade" style={{ left: pct(end), right: 0 }} aria-hidden />
        <div className="ds-trim__range" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} aria-hidden />
        <span className="ds-trim__handle" role="slider" tabIndex={0} aria-label="In point" aria-valuemin={0} aria-valuemax={end - 1} aria-valuenow={start} style={{ left: pct(start) }} onPointerDown={dragHandle("start")} onKeyDown={keyHandle("start")} />
        <span className="ds-trim__handle ds-trim__handle--end" role="slider" tabIndex={0} aria-label="Out point" aria-valuemin={start + 1} aria-valuemax={total} aria-valuenow={end} style={{ left: pct(end) }} onPointerDown={dragHandle("end")} onKeyDown={keyHandle("end")} />
        <span className="ds-trim__playhead" style={{ left: pct(head) }} aria-hidden />
      </div>
    </div>
  );
}

/* ScrollFades: mount once. Every scrollable region of the design system shows a soft fade at the edge(s) where more
   content is waiting, and none where it is already at the start or end. */
const FADE_SELECTOR = ".ds-panel__body, .ds-canvas__body, .ds-dialog__body, .ds-shotstrip, .ds-thumbgrid--compact, .ds-reftray__row, .ds-layerlist, .ds-dock__body, .ds-menu, .ds-cardscroll";
export function ScrollFades() {
  useEffect(() => {
    let raf = 0;
    const update = (el: Element) => {
      const e = el as HTMLElement;
      const y = e.scrollHeight - e.clientHeight > 2;
      const x = e.scrollWidth - e.clientWidth > 2;
      const set = (name: string, on: boolean) => (on ? e.setAttribute(name, "") : e.removeAttribute(name));
      set("data-fade-top", y && e.scrollTop > 2);
      set("data-fade-bottom", y && e.scrollTop + e.clientHeight < e.scrollHeight - 2);
      set("data-fade-left", x && e.scrollLeft > 2);
      set("data-fade-right", x && e.scrollLeft + e.clientWidth < e.scrollWidth - 2);
    };
    const all = () => { raf = 0; document.querySelectorAll(FADE_SELECTOR).forEach(update); };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(all); };
    const onScroll = (e: Event) => { const t = e.target as Element; if (t instanceof Element && t.matches?.(FADE_SELECTOR)) update(t); };
    document.addEventListener("scroll", onScroll, true);
    addEventListener("resize", schedule);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-collapsed"] });
    schedule();
    return () => { document.removeEventListener("scroll", onScroll, true); removeEventListener("resize", schedule); mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  return null;
}

/* Working: the waiting indicator for work that takes a while (AI edits, renders). A pulsing sparkle, a shimmering
   sentence, and a running clock, so it is clear that something is happening and for how long. */
export function Working({ label, hint }: { label: string; hint?: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="ds-working" role="status" aria-live="polite">
      <span className="ds-working__icon" aria-hidden><Sparkles size={16} /></span>
      <span className="ds-working__copy">
        <ShimmerText>{label}</ShimmerText>
        {hint && <span className="ds-working__hint">{hint}</span>}
      </span>
      <span className="ds-working__time">{secs}s</span>
    </div>
  );
}

/* ContextMenu: a short list at the pointer (right-click). Closes on any click elsewhere or Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: Array<{ id: string; label: string; onSelect: () => void; danger?: boolean }>; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [onClose]);
  return createPortal(
    <div ref={box} className="ds-menu ds-dropdown ds-contextmenu" role="menu" style={{ position: "fixed", left: pos.x, top: pos.y, bottom: "auto", zIndex: 100 }}>
      {items.map((i) => (
        <button key={i.id} type="button" role="menuitem" className="ds-menu__item" data-danger={i.danger || undefined} onClick={() => { onClose(); i.onSelect(); }}>{i.label}</button>
      ))}
    </div>,
    document.body,
  );
}

/* TileGrid / ModelTile: a gallery of things you can open (models, workflows). Each tile is one click: icon, name,
   one line of purpose and a status. Details open in a dialog, never inline. */
export function TileGrid({ label, children }: { label: string; children: ReactNode }) {
  const [density] = useDensity();
  const columns = densityColumns(density, gridItemCount(children));
  return <div className="ds-tilegrid" role="list" aria-label={label} style={{ ["--cols" as string]: columns }}>{children}</div>;
}

export function ModelTile({ icon, title, text, status, dim, roomy, onClick }: { icon: ReactNode; title: string; text?: string; status?: ReactNode; dim?: boolean; /** More padding around the copy for short, touch-like galleries. */ roomy?: boolean; onClick: () => void }) {
  return (
    <div role="listitem" className="ds-tile" data-dim={dim || undefined} data-roomy={roomy || undefined}>
      <button type="button" className="ds-tile__main" onClick={onClick}>
        <span className="ds-tile__icon">{icon}</span>
        <span className="ds-tile__copy">
          <span className="ds-tile__title">{title}</span>
          {status && <span className="ds-tile__status">{status}</span>}
          {text && <span className="ds-tile__text">{text}</span>}
        </span>
      </button>
    </div>
  );
}

/* Density: how many items sit in a row on grids (library, runs, models). One setting for every page, remembered,
   changed in the title line (DensityControl in the WorkspaceBar). */
const DENSITY_KEY = "comfyfield.density";
function gridItemCount(children:ReactNode):number{
  return Children.toArray(children).reduce<number>((count,child)=>count+(isValidElement<{children?:ReactNode}>(child)&&child.type===Fragment?gridItemCount(child.props.children):1),0);
}
const clampDensity = (n: number) => Math.min(6, Math.max(1, Math.round(n)));
export function densityColumns(density: number, itemCount: number) {
  return Math.max(1, Math.min(clampDensity(density), Math.max(1, Math.floor(itemCount))));
}
export function densityColumnsClass(density: number, itemCount: number) {
  return `ds-density-cols-${densityColumns(density, itemCount)}`;
}
const densityStore = {
  value: (() => { try { return clampDensity(Number(localStorage.getItem(DENSITY_KEY)) || Number(localStorage.getItem("comfyfield.library.columns")) || 4); } catch { return 4; } })(),
  listeners: new Set<() => void>(),
};
function applyDensity() {
  const v = densityStore.value;
  const root = document.documentElement.style;
  root.setProperty("--density-cols", String(v));
}
export function useDensity(): [number, (n: number) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    densityStore.listeners.add(l);
    applyDensity();
    return () => { densityStore.listeners.delete(l); };
  }, []);
  return [densityStore.value, (n) => {
    densityStore.value = clampDensity(n);
    try { localStorage.setItem(DENSITY_KEY, String(densityStore.value)); } catch { /* not saved */ }
    applyDensity();
    densityStore.listeners.forEach((l) => l());
  }];
}

export function DensityControl() {
  const [value, setValue] = useDensity();
  const id = useId();
  return (
    <div className="ds-density" title={`Items per row: ${value}`}>
      <button type="button" className="ds-density__trigger" aria-label="Items per row" aria-controls={id} onClick={() => document.getElementById(id)?.focus()}><Grid3X3 size={16} /></button>
      <div className="ds-density__details">
        <Slider id={id} className="ds-density__slider" aria-label="Items per row" min={1} max={6} step={1} value={value} onChange={(e) => setValue(Number(e.target.value))} />
        <span className="ds-density__value" aria-hidden>{value}</span>
      </div>
    </div>
  );
}

import {AnnotationEditor} from "./AnnotationEditor";
import type {ImageAnnotation} from "../image/annotations";
export type MediaEditSource={src:string;name:string;mediaType:"image"|"video";intent:"edit"|"modify"|"annotate";annotations?:ImageAnnotation[]};
type CropResult={src:string;name:string};
type SaveCrop=(file:File)=>Promise<CropResult|void>|CropResult|void;
/** One place a picture or clip can go from the full view; `run` fills that tool and opens it. */
export type MediaToolChoice={id:string;label:string;note?:string;icon?:ReactNode;run:()=>Promise<void>|void};
/** What the app can do with one picture or clip. A button is drawn only for what is present (rule 26). */
export type MediaToolSet={animate?:()=>Promise<void>|void;openIn?:MediaToolChoice[];reference?:MediaToolChoice[];upscale?:()=>Promise<void>|void;downloadHref?:string};
type MediaToolMedia={src:string;name:string;mediaType:"image"|"video"};
const mediaEditContext=createContext<{onEdit?:(source:MediaEditSource)=>Promise<void>|void;saveCrop?:SaveCrop;canAnnotate?:boolean;tools?:(media:MediaToolMedia)=>MediaToolSet|undefined}>({});
export function MediaEditProvider({children,onEdit,saveCrop,canAnnotate=false,tools}:{children:ReactNode;onEdit?:(source:MediaEditSource)=>Promise<void>|void;saveCrop?:SaveCrop;canAnnotate?:boolean;tools?:(media:MediaToolMedia)=>MediaToolSet|undefined}){
  return <mediaEditContext.Provider value={{onEdit,saveCrop,canAnnotate,tools}}>{children}</mediaEditContext.Provider>;
}
export function useMediaEditor(){return useContext(mediaEditContext);}
function mediaAt(root:HTMLElement|null){
  const media=root?.querySelector<HTMLImageElement|HTMLVideoElement>("img,video");
  return media?.getAttribute("src")?{src:media.getAttribute("src")!,name:media.getAttribute("alt")||media.getAttribute("aria-label")||"Preview",mediaType:media.tagName==="VIDEO"?"video" as const:"image" as const}:null;
}
function hasMediaNode(node:ReactNode):boolean{
  return Children.toArray(node).some(child=>isValidElement<{children?:ReactNode}>(child)&&(["img","video"].includes(String(child.type))||hasMediaNode(child.props.children)));
}
function useSurfacePreview<T extends HTMLElement=HTMLDivElement>(){
  const ref=useRef<T>(null),[source,setSource]=useState<ReturnType<typeof mediaAt>>(null),editor=useContext(mediaEditContext);
  const open=()=>{const media=mediaAt(ref.current);ref.current?.querySelectorAll("video").forEach(video=>video.pause());setSource(media);};
  const edit=()=>{const media=mediaAt(ref.current);if(media)void Promise.resolve(editor.onEdit?.({...media,intent:"edit"})).catch(()=>setSource(media));};
  return {ref,open,edit,canEdit:!!editor.onEdit,actions:<><IconButton label="Full view" onClick={open}><Maximize2 size={14}/></IconButton>{editor.onEdit&&<IconButton label="Edit media" onClick={edit}><Pencil size={14}/></IconButton>}</>,viewer:source&&<MediaViewer open={true} src={source?.src??""} name={source?.name??"Preview"} mediaType={source?.mediaType} onClose={()=>setSource(null)}/>};
}

/* Full preview shares image crop and the app's existing editor routes. Cropping always saves a copy. */
export function MediaViewer({ open, src, name, onClose, actions, onActivate, mediaType = "image",onCrop,compare }: { open: boolean; src: string; name: string; onClose: () => void; actions?: ReactNode; onActivate?: () => void; mediaType?: "image" | "video";onCrop?:SaveCrop;compare?:{src:string;name:string} }) {
  const panel = useRef<HTMLDivElement>(null);
  const image=useRef<HTMLImageElement>(null),editor=useContext(mediaEditContext),urls=useRef<string[]>([]),start=useRef<{x:number;y:number}|null>(null);
  const [annotationOpen,setAnnotationOpen]=useState(false),[chooser,setChooser]=useState<"openIn"|"reference"|null>(null);
  const generation=useRef(0);
  const [result,setResult]=useState<CropResult|null>(null),[crop,setCrop]=useState<{x:number;y:number;w:number;h:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const primary=useRef<HTMLVideoElement>(null),reference=useRef<HTMLVideoElement>(null),[linked,setLinked]=useState(true),[playbackHint,setPlaybackHint]=useState("");
  useEffect(()=>{setLinked(true);setPlaybackHint("");},[open,src,compare?.src]);
  useEffect(()=>{if(open&&linked&&mediaType==="video"&&compare&&primary.current&&reference.current)return linkMediaPlayback(reference.current,primary.current,setPlaybackHint);},[open,linked,mediaType,src,compare?.src]);
  useEffect(()=>{const revision=++generation.current;setResult(null);setCrop(null);setAnnotationOpen(false);setBusy(false);setError("");start.current=null;return()=>{if(generation.current===revision)generation.current++;urls.current.forEach(url=>URL.revokeObjectURL(url));urls.current=[];};},[open,src]);
  const current=result??{src,name};
  const tools=open?editor.tools?.({src:current.src,name:current.name,mediaType}):undefined;
  const point=(event:ReactPointerEvent)=>{const r=image.current!.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))};};
  async function applyCrop(){
    const img=image.current;if(!img||!crop||busy||!img.naturalWidth)return;
    const revision=generation.current;
    setBusy(true);setError("");
    try{
      const x=Math.min(img.naturalWidth-1,Math.round(crop.x*img.naturalWidth)),y=Math.min(img.naturalHeight-1,Math.round(crop.y*img.naturalHeight));
      const w=Math.min(img.naturalWidth-x,Math.max(1,Math.round(crop.w*img.naturalWidth))),h=Math.min(img.naturalHeight-y,Math.max(1,Math.round(crop.h*img.naturalHeight)));
      const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Crop is unavailable in this browser.");ctx.drawImage(img,x,y,w,h,0,0,w,h);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Could not create the crop.")),"image/png"));
      const file=new File([blob],`${current.name.replace(/\.[^.]+$/,"")}-crop.png`,{type:"image/png"});
      if(revision!==generation.current)return;
      const saved=await (onCrop??editor.saveCrop)?.(file);
      if(revision!==generation.current)return;
      if(saved)setResult(saved);else{const url=URL.createObjectURL(file);urls.current.push(url);setResult({src:url,name:file.name});}
      setCrop(null);
    }catch(cause){if(revision===generation.current)setError((cause as Error).message);}finally{if(revision===generation.current)setBusy(false);}
  }
  async function edit(intent:"edit"|"modify"){
    if(!editor.onEdit||busy)return;setBusy(true);setError("");
    const revision=generation.current;
    try{await editor.onEdit({...current,mediaType,intent});if(revision===generation.current)onClose();}catch(cause){if(revision===generation.current)setError((cause as Error).message);}finally{if(revision===generation.current)setBusy(false);}
  }
  /** Runs one of the full view's actions; the view closes once the target tool is open. */
  async function go(run:()=>Promise<void>|void){
    if(busy)return;setBusy(true);setError("");const revision=generation.current;
    try{await run();if(revision===generation.current)onClose();}catch(cause){if(revision===generation.current)setError((cause as Error).message);}finally{if(revision===generation.current)setBusy(false);}
  }
  useModalFocus(open&&!annotationOpen&&!chooser, panel, onClose);
  if (!open) return null;
  return createPortal(
    <div className="ds-viewer" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} ref={panel} onClick={event=>event.stopPropagation()} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ds-viewer__frame">
        {mediaType === "video" ? compare?<div className="ds-viewer__video-pair"><figure><figcaption>{compare.name}</figcaption><video ref={reference} src={compare.src} aria-label={compare.name} controls muted playsInline preload="metadata"/></figure><figure><figcaption>Result</figcaption><video ref={primary} src={current.src} aria-label="Comparison result" controls playsInline preload="metadata"/></figure></div>:<video ref={primary} src={current.src} aria-label={current.name} controls autoPlay playsInline onDoubleClick={onActivate} /> : <div className="ds-viewer__image" data-cropping={!!crop||undefined}
          onPointerDown={event=>{if(!crop||busy)return;event.preventDefault();start.current=point(event);event.currentTarget.setPointerCapture(event.pointerId);setCrop({...start.current,w:0,h:0});}}
          onPointerMove={event=>{if(!crop||!start.current)return;const end=point(event),a=start.current;setCrop({x:Math.min(a.x,end.x),y:Math.min(a.y,end.y),w:Math.abs(a.x-end.x),h:Math.abs(a.y-end.y)});}}
          onPointerUp={()=>{start.current=null;}} onPointerCancel={()=>{start.current=null;}}>
          <img ref={image} src={current.src} alt={current.name} draggable={false} onDoubleClick={onActivate}/>
          {crop&&<span className="ds-viewer__crop" style={{left:`${crop.x*100}%`,top:`${crop.y*100}%`,width:`${crop.w*100}%`,height:`${crop.h*100}%`}}/>}
        </div>}
        <div className="ds-viewer__actions">
          {crop?<><Button disabled={busy||!crop.w||!crop.h} onClick={()=>void applyCrop()}>Apply crop</Button><Button disabled={busy} onClick={()=>setCrop(null)}>Cancel crop</Button></>:<>
          {mediaType==="image"&&<Button disabled={busy} onClick={()=>setCrop({x:.05,y:.05,w:.9,h:.9})}><Crop size={14}/>Quick crop</Button>}
          {mediaType==="image"&&editor.onEdit&&editor.canAnnotate&&<Button disabled={busy} onClick={()=>setAnnotationOpen(true)}>Annotate</Button>}
          {mediaType==="image"&&editor.onEdit&&<Button disabled={busy} onClick={()=>void edit("modify")}><Sparkles size={14}/>Modify with AI</Button>}
          {mediaType==="video"&&compare&&<Tooltip content={playbackHint||"Playback is linked by elapsed time over the shared duration. Unlink to inspect each clip independently."}><Button aria-pressed={linked} onClick={()=>setLinked(value=>!value)}><Link2 size={14}/>{linked?"Unlink playback":"Link playback"}</Button></Tooltip>}
          {result&&<LinkButton href={result.src} download={result.name}>Download crop</LinkButton>}
          {actions}
          </>}
          <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
        </div>
        {crop&&<span className="ds-viewer__hint">Drag over the image to choose a crop. The original is kept.</span>}
        {error&&<div className="ds-viewer__hint" role="alert">{error}</div>}
        <AnnotationEditor open={annotationOpen} src={current.src} onClose={()=>setAnnotationOpen(false)} onApply={async annotations=>{if(!editor.onEdit)throw new Error("Image editing is unavailable.");await editor.onEdit({...current,mediaType:"image",intent:"annotate",annotations});setAnnotationOpen(false);onClose();}}/>
      </div>
      <aside className="ds-viewer__panel" aria-label="Actions for this media">
        <div className="ds-viewer__tools">
          {tools?.animate&&mediaType==="image"&&<Button variant="primary" disabled={busy} onClick={()=>void go(tools.animate!)}><Video size={14}/>Animate</Button>}
          {editor.onEdit&&<Button variant={tools?.animate&&mediaType==="image"?"secondary":"primary"} disabled={busy} onClick={()=>void edit("edit")}><Pencil size={14}/>Edit</Button>}
          {!!tools?.openIn?.length&&<Button disabled={busy} onClick={()=>setChooser("openIn")}><LayoutGrid size={14}/>Open in</Button>}
          {!!tools?.reference?.length&&<Button disabled={busy} onClick={()=>tools.reference!.length===1?void go(tools.reference![0].run):setChooser("reference")}><ImagePlus size={14}/>Reference</Button>}
          {tools?.upscale&&<Button disabled={busy} onClick={()=>void go(tools.upscale!)}><ArrowUpRight size={14}/>Upscale</Button>}
          <LinkButton variant="secondary" href={tools?.downloadHref??current.src} download={current.name}><Download size={14}/>Download</LinkButton>
        </div>
      </aside>
      {chooser&&tools&&<ChoiceDialog open title={chooser==="openIn"?"Open in":"Use as reference in"} options={(tools[chooser]??[]).map(choice=>({value:choice.id,label:choice.label,note:choice.note,icon:choice.icon}))} onPick={id=>{const choice=tools[chooser]?.find(item=>item.id===id);setChooser(null);if(choice)void go(choice.run);}} onClose={()=>setChooser(null)}/>}
    </div>,
    document.body,
  );
}

/* CommandBar: one line to say what you want. It floats at the top center above the page, grows while you type,
   Enter sends, and the mode (Auto, Image, Video) sits inside it. A hint only shows when something blocks. */
export function CommandBar<T extends string>({ label, value, onChange, placeholder, onSubmit, submitLabel, submitDisabled, busy, mode, hint }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  busy?: boolean;
  mode?: { value: T; onChange: (v: T) => void; items: Array<{ id: T; label: string }> };
  hint?: string;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [value]);
  return (
    <div className="ds-commandbar" role="search" aria-label={label}>
      <span className="ds-commandbar__icon" aria-hidden><Sparkles size={16} /></span>
      <textarea
        ref={box}
        className="ds-commandbar__input"
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && onSubmit && !submitDisabled && !busy) { e.preventDefault(); onSubmit(); } }}
      />
      {mode && (
        <SegmentedTabs quiet label={`${label} mode`} value={mode.value} onChange={mode.onChange} items={mode.items} />
      )}
      {onSubmit && (
        <button type="button" className="ds-commandbar__go" aria-label={submitLabel ?? "Send"} title={submitLabel} disabled={submitDisabled || busy} data-busy={busy || undefined} onClick={onSubmit}>
          <ArrowRight size={16} />
        </button>
      )}
      {hint && <span className="ds-commandbar__hint">{hint}</span>}
    </div>
  );
}

/* ExpandToggle: an on/off switch that is only an icon until you hover or focus it, then it opens into a labelled
   button with its state. For quiet, optional features (the free input). */
export function ExpandToggle({ icon, label, on, onChange }: { icon: ReactNode; label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="ds-expandtoggle" data-on={on || undefined} onClick={() => onChange(!on)}>
      <span className="ds-expandtoggle__icon">{icon}</span>
      <span className="ds-expandtoggle__text">
        <span>{label}</span>
        <span className="ds-expandtoggle__state">{on ? "On" : "Off"}</span>
      </span>
    </button>
  );
}

/* Reveal: mount once. Grids and lists with more than two items ease in as they come into view, top to bottom, each
   item a moment after the one above. Items that are already there on load stagger from the top. */
const REVEAL_PARENTS = ".ds-grid, .cf-library-grid, .cf-runs-grid, .ds-tilegrid, .ds-historygrid, .ds-resultgrid, .ds-thumbgrid, .ds-itemlist, .ds-presetgrid, .cf-asset-grid";
export function Reveal() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const seen = new WeakSet<Element>();
    let queue: HTMLElement[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      queue.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      queue.forEach((el, i) => { el.style.setProperty("--reveal-delay", `${Math.min(i, 12) * 55}ms`); el.setAttribute("data-in", ""); });
      queue = [];
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        queue.push(e.target as HTMLElement);
      }
      if (queue.length && !raf) raf = requestAnimationFrame(flush);
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
    const scan = () => {
      document.querySelectorAll(REVEAL_PARENTS).forEach((parent) => {
        if (parent.childElementCount <= 2) return;
        Array.from(parent.children).forEach((child) => {
          if (seen.has(child)) return;
          seen.add(child);
          child.setAttribute("data-reveal", "");
          io.observe(child);
        });
      });
    };
    let scanRaf = 0;
    const schedule = () => { if (!scanRaf) scanRaf = requestAnimationFrame(() => { scanRaf = 0; scan(); }); };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
    return () => { io.disconnect(); mo.disconnect(); cancelAnimationFrame(raf); cancelAnimationFrame(scanRaf); };
  }, []);
  return null;
}

/* OptionsBar: the strip above an editor. Options of the active tool at the start, global actions (undo, zoom) at the end. */
export function OptionsBar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="ds-optionsbar">
      <div className="ds-optionsbar__start">{children}</div>
      {end && <div className="ds-optionsbar__end">{end}</div>}
    </div>
  );
}

/* StatusBar: facts about the open document (zoom, size), at the bottom of an editor. Quiet, level 3. */
export function StatusBar({ children }: { children: ReactNode }) {
  return <div className="ds-statusbar">{children}</div>;
}

/* HintButton: the "what is still missing" lines live behind a small "i" (hover, focus or click) instead of sitting above the main action. */
export function HintButton({ id, children }: { id?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ds-hint" data-open={open || undefined}>
      <button type="button" className="ds-hint__button" aria-label="What is missing" aria-expanded={open} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)}>
        <Info size={14} />
      </button>
      <div className="ds-hint__sheet" id={id} role="status">{children}</div>
    </div>
  );
}

/* ContextBar: level-2 strip under the top bar. Where you are (start), what it is (meta), view switch (end). */
export function ContextBar({ start, meta, center, end }: { start?: ReactNode; meta?: ReactNode; /** The view switch (Create / Storyboard). Centered, so it is the first thing the eye finds. */ center?: ReactNode; end?: ReactNode }) {
  return (
    <div className="ds-contextbar" data-centered={center ? true : undefined}>
      <span className="ds-contextbar__start">
        {start}
        {meta}
      </span>
      {center && <span className="ds-contextbar__center">{center}</span>}
      {end && <span className="ds-contextbar__end">{end}</span>}
    </div>
  );
}

/* Problems have ONE place. Every danger Notice on a screen is rendered into the ProblemBar under the top bar
   (through a portal, so its buttons stay live). The bar shows the most important one as a single row; the others sit
   behind "+N more". A Notice that is only a consequence of another (no queue because the server is down) is hidden while
   its cause is shown. Notices inside dialogs and forms stay where they are. */
const ProblemContext = createContext<{ slot: HTMLElement | null; setSlot: (el: HTMLElement | null) => void }>({ slot: null, setSlot: () => {} });
const InDialogContext = createContext(false);

export function ProblemHost({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const api = useMemo(() => ({ slot, setSlot }), [slot]);
  return <ProblemContext.Provider value={api}>{children}</ProblemContext.Provider>;
}

export function ProblemBar() {
  const { setSlot } = useContext(ProblemContext);
  const holder = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [count, setCount] = useState(0);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const arrange = useCallback(() => {
    const el = slotRef.current;
    if (!el) return;
    const rows = Array.from(el.children) as HTMLElement[];
    const selected = selectProblems(rows.map(row => ({
      key: [row.querySelector(".ds-problemrow__title")?.textContent, row.querySelector(".ds-problemrow__text")?.textContent].filter(Boolean).join("\n") || row.textContent || "",
      priority: -Number(row.style.order || 0),
      consequence: row.hasAttribute("data-consequence"),
    })));
    const shown = new Set(expanded ? selected : selected.slice(0, 1));
    rows.forEach((row, index) => {
      if (shown.has(index)) row.setAttribute("data-shown", "");
      else row.removeAttribute("data-shown");
    });
    setCount(c => c === selected.length ? c : selected.length);
  }, [expanded]);
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    setSlot(el);
    arrange();
    const watcher = new MutationObserver(arrange);
    watcher.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["style", "data-consequence"] });
    return () => {
      watcher.disconnect();
      setSlot(null);
    };
  }, [arrange, setSlot]);
  return (
    <div className="ds-problembar" ref={holder} data-empty={count === 0 || undefined} data-collapsed={collapsed || undefined}>
      {collapsed && (
        <button type="button" className="ds-problembar__bubble" aria-label={`Show ${count} error message${count === 1 ? "" : "s"}`} onClick={() => setCollapsed(false)}>
          <AlertCircle size={16} className="ds-problemrow__icon" aria-hidden />
          <span>{count}</span>
        </button>
      )}
      <div className="ds-problemslot" ref={slotRef} />
      {!collapsed && (
        <>
          {count > 1 && (
            <Button variant="ghost" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Show less" : `+${count - 1} more`}
            </Button>
          )}
          <IconButton label="Collapse error messages" onClick={() => setCollapsed(true)}>
            <X size={14} />
          </IconButton>
        </>
      )}
    </div>
  );
}

/* TextField: the one text input (label above, hint or error below, password reveal). */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  type = "text",
  inputRef,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> & {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string;
  type?: "text" | "email" | "password" | "url" | "number";
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const secret = type === "password";
  return (
    <div className="ds-field" data-invalid={error ? true : undefined}>
      <label className="ds-field__label" htmlFor={id}>
        {label}
      </label>
      <span className="ds-field__box">
        <input {...rest} id={id} ref={inputRef} type={secret && shown ? "text" : type} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} />
        {secret && (
          <IconButton label={shown ? "Hide password" : "Show password"} onClick={() => setShown((v) => !v)}>
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconButton>
        )}
      </span>
      {(error || hint) && <span className="ds-field__note">{error ?? hint}</span>}
    </div>
  );
}

/* Checkbox: one option with a label. */
export function Checkbox({ checked, onChange, disabled, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <label className="ds-check" data-disabled={disabled || undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ds-check__box" aria-hidden>
        {checked && <Check size={12} />}
      </span>
      <span>{children}</span>
    </label>
  );
}

/* FormSection: a titled group of fields inside a dialog or page. */
export function FormSection({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="ds-formsection">
      <SectionHeader title={title} meta={meta} />
      {children}
    </section>
  );
}

/* DataRow: one record in a settings list (worker, key, member, invitation). Not a link; actions on the right. */
export function DataRow({ title, meta, status, actions }: { title: ReactNode; meta?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ds-datarow">
      <span className="ds-datarow__copy">
        <span className="ds-datarow__title">{title}</span>
        {meta}
      </span>
      {status}
      {actions && <span className="ds-datarow__actions">{actions}</span>}
    </div>
  );
}

/* ConfirmDialog: every destructive action asks first, in one sentence, with a clear verb. */
export function ConfirmDialog({ open, title, text, confirmLabel, busy, error, onConfirm, onCancel }: { open: boolean; title: string; text: string; confirmLabel: string; busy?: boolean; error?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="ds-clamp__full">{text}</p>
      {error&&<Notice inline priority={20} title="Action not completed">{error}</Notice>}
    </Dialog>
  );
}

/* Toasts: quiet confirmation after an action ("Saved", "Copied"). Never for problems; those are Notice. */
type Toast = { id: number; text: string };
const ToastContext = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="ds-toasts" aria-live="polite">
        {toasts.map((t) => (
          <span key={t.id} className="ds-toast">
            <Check size={14} />
            {t.text}
          </span>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* UserMenu: the avatar opens a small menu (account, settings, sign out), not a dialog. */
export type UserMenuItem = { id: string; label: string; icon?: ReactNode; onSelect: () => void };
export function UserMenu({ initials, name, meta, extra, items }: { initials: string; name: string; meta?: ReactNode; /** A short block under the name, such as a credit balance and its link. */ extra?: ReactNode; items: UserMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("keydown", key);
    addEventListener("mousedown", away);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("mousedown", away);
    };
  }, [open]);
  return (
    <span className="ds-usermenu" ref={ref}>
      <button type="button" className="ds-usermenu__trigger" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((o) => !o)}>
        <Avatar initials={initials} />
      </button>
      {open && (
        <div className="ds-usermenu__panel" role="menu">
          <div className="ds-usermenu__who">
            <span className="ds-usermenu__name">{name}</span>
            {meta}
          </div>
          {extra && <div className="ds-usermenu__extra">{extra}</div>}
          {items.map((i) => (
            <button key={i.id} type="button" role="menuitem" className="ds-menu__item" onClick={() => { setOpen(false); i.onSelect(); }}>
              {i.icon}
              {i.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/* PresetGrid / PresetCard: pick one look (camera moves, styles). A thumbnail or icon, a name, one line.
   `size="tool"` is the All tools tile: the same card with its name one step larger and clear of the art. */
export function PresetGrid({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="ds-presetgrid" role="radiogroup" aria-label={label}>
      {children}
    </div>
  );
}
export function PresetCard({ label, hint, thumb, thumbs, icon, selected, size, featured, onSelect }: { /** Pictures shown one after another (a slow cross-fade) when there are several; `thumb` leads. */ thumbs?: string[]; /** The one card the product leads with: a thin brand-yellow ring. */ featured?: boolean; label: string; hint?: string; thumb?: string; icon?: ReactNode; selected?: boolean; /** The larger name and air of an All tools tile. */ size?: "tool"; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={!!selected} className={cx("ds-preset", size === "tool" && "ds-preset--tool", featured && "ds-preset--featured")} onClick={onSelect}>
      <span className="ds-preset__art">{thumb ? <RotatingPicture first={thumb} more={thumbs} /> : icon}</span>
      <span className="ds-preset__label" title={size === "tool" ? label : undefined}>{label}</span>
      {hint && <span className="ds-preset__hint">{hint}</span>}
    </button>
  );
}

/* A card shows one of its pictures; which one changes with every page load (the list comes in already turned), never on a timer. */
function RotatingPicture({ first }: { first: string; more?: string[] }) {
  return <img src={first} alt="" loading="lazy" />;
}

/* A hero video plays one clip of the set, in a loop; the app picks a different clip on every page load. */
export function RotatingVideo({ srcs }: { srcs: string[] }) {
  const reduced = useReducedMotion();
  if (!srcs.length) return null;
  return <video className="ds-rotvid" src={srcs[0]} muted autoPlay={!reduced} loop playsInline preload="auto" aria-hidden />;
}

/* EmptyState: nothing here yet. One title, one sentence, one action. Never an amber Notice. */
export function EmptyState({ icon, title, text, action, stage, plain }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode; /** No loop behind it: a calm empty area such as "No runs yet". */ plain?: boolean; /** The only content of a whole area: centered in it, calm, without a card. */ stage?: boolean }) {
  const reel = useContext(reelContext);
  const clip = stage && !plain ? reel : undefined;
  return (
    <div className={cx("ds-empty", stage && "ds-empty--stage")} data-reel={clip ? "" : undefined}>
      <AmbientReel src={clip} />
      {icon && <span className="ds-empty__icon">{icon}</span>}
      <span className="ds-empty__title">{title}</span>
      {text && <span className="ds-empty__text">{text}</span>}
      {action}
    </div>
  );
}

/* SearchField: the one search input. */
export function SearchField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="ds-search">
      <Search size={14} aria-hidden />
      <input aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/* ItemList / ListItem: a list of things you can open (workflows, projects). Icon, title, one line, facts, state. */
export function ItemList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="ds-itemlist" role="list" aria-label={label}>
      {children}
    </div>
  );
}
export function ListItem({
  icon,
  title,
  text,
  meta,
  status,
  selected,
  dim,
  onClick,
  expanded,
  detailId,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  selected?: boolean;
  /** Not available yet: drawn quieter. */
  dim?: boolean;
  onClick?: () => void;
  expanded?: boolean;
  detailId?: string;
  /** Shown under the row while expanded. */
  children?: ReactNode;
}) {
  const interactive=!!onClick||children!==undefined;
  const content=<>
    {icon && <span className="ds-item__icon">{icon}</span>}
    <span className="ds-item__copy">
      <span className="ds-item__title">{title}</span>
      {text && <span className="ds-item__text">{text}</span>}
      {meta}
    </span>
    {status && <span className="ds-item__status">{status}</span>}
    {interactive&&<ChevronRight size={14} className="ds-item__chev" aria-hidden />}
  </>;
  return (
    <article className="ds-item" role="listitem" data-selected={selected || undefined} data-dim={dim || undefined} data-static={!interactive||undefined}>
      {interactive?<button type="button" className="ds-item__main" onClick={onClick} aria-expanded={children !== undefined ? !!expanded : undefined} aria-controls={detailId} aria-current={selected ? "true" : undefined}>{content}</button>:<div className="ds-item__main">{content}</div>}
      {expanded && children && (
        <div className="ds-item__detail" id={detailId}>
          {children}
        </div>
      )}
    </article>
  );
}

/** The one way to pick one of several: a dialog of boxes (icon, name, one line, status), the picked one outlined.
 *  `Row` with options and the team's choice triggers both open this, so every dropdown looks the same. */
export type ChoiceOption<T extends string | number = string> = { value: T; label: string; note?: string; icon?: ReactNode; status?: OptionStatus; /** Why this one cannot be used, shown in its box. */ detail?: ReactNode; disabled?: boolean };
export function ChoiceDialog<T extends string | number>({ open, title, options, value, onPick, onClose }: { open: boolean; title: string; options: ChoiceOption<T>[]; value?: T; onPick: (value: T) => void; onClose: () => void }) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <ItemList label={title}>
        {options.map((option) => (
          <ListItem
            key={String(option.value)}
            icon={option.icon}
            title={option.label}
            text={option.note}
            meta={option.detail ? <Meta>{option.detail}</Meta> : undefined}
            status={option.status ? <StatusText tone={option.status === "ready" ? "ok" : option.status === "checking" ? "active" : "warn"}>{STATUS_TEXT[option.status]}</StatusText> : undefined}
            selected={option.value === value}
            dim={option.disabled}
            onClick={option.disabled ? undefined : () => onPick(option.value)}
          />
        ))}
      </ItemList>
    </Dialog>
  );
}

/* SectionHeader: level-1 title for a panel or list, with its caption beside it, never as a chip. */
export function SectionHeader({ title, meta, end, large }: { title: ReactNode; meta?: ReactNode; end?: ReactNode; /** A page title (Library, Catalogue, Projects). */ large?: boolean }) {
  return (
    <div className={cx("ds-sectionhead", large && "ds-sectionhead--large")}>
      <h1 className="ds-sectionhead__title">{title}</h1>
      {meta}
      {end && <span className="ds-contextbar__end">{end}</span>}
    </div>
  );
}

export function HistoryItem({
  media,
  portrait,
  model,
  prompt,
  thumb,
  thumbEnd,
  motionVideo,
  motionPrompt,
  inputs,
  facts,
  onRecreate,
  onOpenDetails,
  onDelete,
  meta,
  details,
  actions,
  date,
}: {
  media: ReactNode;
  portrait?: boolean;
  model: ReactNode;
  prompt: string;
  thumb?: string;
  /** The last frame of a first-and-last-frame job, shown after the start frame. */
  thumbEnd?: string;
  /** The driving video of a motion-control job, shown after the character image. */
  motionVideo?: string;
  /** What the driving video's movement is, in words. */
  motionPrompt?: string;
  /** The pictures and clips this result was made from. */
  inputs?: Array<{ src: string; label: string; video?: boolean }>;
  /** Details as plain label and value rows (Model, Quality, Ran on). */
  facts?: Array<{ label: string; value: ReactNode }>;
  /** Opens the tool this was made in with the same inputs and settings. Absent where that cannot work. */
  onRecreate?: () => void;
  /** Called when the details open, so a list that holds only the short record can fetch the rest. */
  onOpenDetails?: () => void;
  /** Deletes this result after a confirm. Absent where the viewer may not delete. */
  onDelete?: () => Promise<void>;
  meta: ReactNode;
  /** Extra technical detail shown inside the opened overlay. */
  details?: ReactNode;
  actions?: ReactNode;
  date: string;
}) {
  // The details are hidden until asked for. They open over the media, so nothing shifts.
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [removing, setRemoving] = useState(false), [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState("");
  const preview=useSurfacePreview();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <article className="ds-hitem">
      {onDelete&&<ConfirmDialog open={removing} title="Delete this result?" text="It is removed from this project for everyone." confirmLabel={deleting?"Deleting…":"Delete"} busy={deleting} error={deleteError} onCancel={()=>{setRemoving(false);setDeleteError("");}} onConfirm={()=>{setDeleting(true);setDeleteError("");void onDelete().then(()=>setRemoving(false)).catch((e:Error)=>setDeleteError(e.message)).finally(()=>setDeleting(false));}}/>}
      <div ref={preview.ref} className={cx("ds-media", portrait && "ds-media--portrait")} data-details-open={open} onClick={event=>{if(event.currentTarget.contains(event.target as Node)&&!(event.target as Element).closest("button,a,audio"))preview.open();}}>
        {media}
        <div className="ds-media__tools">
          {hasMediaNode(media)&&preview.actions}
          <Tooltip content={<>{typeof model==="string"?model:"Media details"}<Meta>{meta}</Meta></>}><IconButton label="Media details" aria-expanded={open} aria-controls={panelId} onClick={() => { setOpen(true); onOpenDetails?.(); }}><Info size={14}/></IconButton></Tooltip>
          {onDelete&&<IconButton label="Delete" onClick={()=>setRemoving(true)}><Trash2 size={14}/></IconButton>}
        </div>
        {open && (
          <Dialog open={open} title={typeof model==="string"?model:"Details"} onClose={()=>setOpen(false)}><div id={panelId} className="ds-media-details">
            {!!inputs?.length && (
              <div className="ds-details__thumbs">
                {inputs.map((input) => input.video
                  ? <video key={input.label} className="ds-details__thumb" src={input.src} muted loop autoPlay playsInline aria-label={input.label} />
                  : <img key={input.label} className="ds-details__thumb" src={input.src} alt={input.label} />)}
              </div>
            )}
            {prompt.trim() && <div className="ds-details__prompt"><span className="ds-details__label">Prompt</span><ClampText text={prompt} lines={4} title="Prompt" /></div>}
            {thumb && (
              <div className="ds-details__thumbs">
                <img className="ds-details__thumb" src={thumb} alt="Start frame" />
                {thumbEnd && (
                  <>
                    <ArrowRight size={14} aria-hidden />
                    <img className="ds-details__thumb" src={thumbEnd} alt="End frame" />
                  </>
                )}
                {motionVideo && (
                  <>
                    <ArrowRight size={14} aria-hidden />
                    <video className="ds-details__thumb" src={motionVideo} muted loop autoPlay playsInline aria-label="Motion video" />
                  </>
                )}
              </div>
            )}
            {motionPrompt && (
              <div className="ds-details__prompt">
                <span className="ds-details__label">Motion</span>
                <ClampText text={motionPrompt} lines={3} title="Motion" />
              </div>
            )}
            {!!facts?.length && (
              <dl className="ds-details__facts">
                {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
              </dl>
            )}
            {details}
            <div className="ds-details__meta">{meta}</div>
            {(onRecreate || actions) && (
              <div className="ds-details__actions">
                {onRecreate && <Button variant="primary" onClick={() => { setOpen(false); onRecreate(); }}><Repeat size={14} />Recreate</Button>}
                {actions}
              </div>
            )}
            <div className="ds-details__date">{date}</div>
          </div></Dialog>
        )}
      </div>
      {preview.viewer}
    </article>
  );
}

/* ── Loading: sparkle, shimmer, skeleton ────────────────────── */

const STAR = "M12 0C12.9 6.6 17.4 11.1 24 12C17.4 12.9 12.9 17.4 12 24C11.1 17.4 6.6 12.9 0 12C6.6 11.1 11.1 6.6 12 0Z";

/** General loading indicator: a breathing four-point star with two twinkles. */
export function SparkleLoader({ size = "md", color, label }: { size?: "sm" | "md" | "lg"; color?: string; label?: string }) {
  const px = size === "sm" ? 18 : size === "lg" ? 64 : 40;
  return (
    <span
      className={cx("ds-sparkle", size === "sm" && "ds-sparkle--sm")}
      style={{ ["--loader-size" as string]: `${px}px`, ...(color ? { ["--loader-color" as string]: color } : {}) }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg className="ds-sparkle__big" viewBox="0 0 24 24"><path d={STAR} /></svg>
      <svg className="ds-sparkle__s1" viewBox="0 0 24 24"><path d={STAR} /></svg>
      <svg className="ds-sparkle__s2" viewBox="0 0 24 24"><path d={STAR} /></svg>
    </span>
  );
}

/** Text that shimmers while its content is loading. */
export function ShimmerText({ children, as: Tag = "span" }: { children: ReactNode; as?: "span" | "p" }) {
  return <Tag className="ds-shimmer">{children}</Tag>;
}

export function Skeleton({ width = "100%", height = 12 }: { width?: number | string; height?: number }) {
  return <span className="ds-skeleton" style={{ display: "block", width, height }} aria-hidden />;
}

/* ── Progress and notices ───────────────────────────────────── */

export function Progress({
  label,
  value,
  detail,
  action,
}: {
  label: string;
  value: number | null;
  /** A quiet second line, such as the place in a queue. */
  detail?: string;
  /** Something to do about it, such as a Cancel button. */
  action?: ReactNode;
}) {
  return (
    <div className="ds-progress" role="status">
      <SparkleLoader />
      <span className="ds-progress__label">
        <ShimmerText>{label}</ShimmerText>
        {value !== null && <span className="ds-progress__pct">{value}%</span>}
      </span>
      {detail && <span className="ds-progress__detail">{detail}</span>}
      {action}
    </div>
  );
}

/**
 * The one way to show an error or a hint. Plain sentence case, regular weight;
 * the tone only changes the icon color and hairline.
 */
export function Notice({
  tone = "danger",
  title,
  children,
  actions,
  details,
  priority = 0,
  consequence,
  inline,
  global,
}: {
  tone?: "danger" | "info";
  title?: string;
  children?: ReactNode;
  /** The ways out of the problem. Always below the text, left-aligned, never mixed into the sentence. */
  actions?: ReactNode;
  /** The technical text (a code, an address, a worker message), kept for support and shown only when asked. */
  details?: string;
  /** Higher is shown first in the problem bar. */
  priority?: number;
  /** Only a result of another problem: hidden while that one is shown. */
  consequence?: boolean;
  /** Keep it where it is (inside a form or dialog) instead of the problem bar. */
  inline?: boolean;
  /** Route a dialog-level problem into the workspace problem bar. */
  global?: boolean;
}) {
  const { slot } = useContext(ProblemContext);
  const inDialog = useContext(InDialogContext);
  const Icon = tone === "danger" ? AlertCircle : Info;
  if (tone === "danger" && slot && !inline && (!inDialog || global)) {
    return createPortal(
      <div className="ds-problemrow" role="alert" style={{ order: -priority }} data-consequence={consequence ? "" : undefined}>
        <Icon size={16} className="ds-problemrow__icon" aria-hidden />
        <div className="ds-problemrow__body">
          {title && <span className="ds-problemrow__title">{title}</span>}
          {children && <span className="ds-problemrow__text">{children}</span>}
          {details && <NoticeDetails text={details} />}
        </div>
        {actions && <div className="ds-problemrow__actions">{actions}</div>}
      </div>,
      slot,
    );
  }
  return (
    <div className={cx("ds-notice", tone === "danger" && "ds-notice--danger")} role={tone === "danger" ? "alert" : "note"}>
      <Icon size={16} className="ds-notice__icon" aria-hidden />
      <div className="ds-notice__body">
        {title && <span className="ds-notice__title">{title}</span>}
        {children}
        {details && <NoticeDetails text={details} />}
        {actions && <div className="ds-notice__actions">{actions}</div>}
      </div>
    </div>
  );
}

/* The technical half of a problem: closed by default, copyable when a person asks for it (rule 39). */
function NoticeDetails({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="ds-notice__details">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide details" : "Details"}
      </Button>
      {open && <CodeLine copyLabel="Copy details">{text}</CodeLine>}
    </span>
  );
}

/* ── Empty state: How it works ──────────────────────────────── */

export function HowItWorks({
  title,
  lead,
  steps,
  compact = false,
}: {
  title: string;
  lead: string;
  steps: Array<{ icon: ReactNode; title: string; text: string }>;
  /** A short numbered list for side panels: no display title, steps stacked, text in one quiet line. */
  compact?: boolean;
}) {
  return (
    <div className={cx("ds-howto", compact && "ds-howto--compact")} aria-label={compact ? title : undefined}>
      {!compact && <h2 className="ds-display">{title}</h2>}
      {lead && <p className="ds-howto__lead">{lead}</p>}
      <div className="ds-steps">
        {steps.map((s, i) => (
          <div key={s.title} className="ds-step">
            <div className="ds-step__art">
              <span className="ds-step__num">0{i + 1}</span>
              {s.icon}
            </div>
            <h3 className="ds-step__title">{s.title}</h3>
            <p className="ds-step__text">{s.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Node graph ─────────────────────────────────────────────── */
// Visual layer for ComfyUI graphs. Positions are plain numbers in graph space,
// so a later step can feed in ComfyUI's own node positions unchanged.

export type SocketType = "image" | "latent" | "model" | "clip" | "vae" | "conditioning" | "video" | "int" | "string";

export const NODE_HEAD_H = 40;
export const SOCKET_H = 24;
const BODY_PAD_TOP = 8;

/** Y offset of a socket's port from the node's top edge. */
export function socketY(index: number) {
  return NODE_HEAD_H + BODY_PAD_TOP + index * (SOCKET_H + 2) + SOCKET_H / 2;
}

export function Graph({ height, children, wires }: { height: number; children: ReactNode; wires?: ReactNode }) {
  return (
    <div className="ds-graph" style={{ height }}>
      <svg className="ds-graph__wires" width="100%" height="100%">{wires}</svg>
      {children}
    </div>
  );
}

/** Bezier wire between two points, colored by socket type. */
export function Wire({
  from,
  to,
  type,
  active,
}: {
  from: [number, number];
  to: [number, number];
  type: SocketType;
  active?: boolean;
}) {
  const dx = Math.max(60, (to[0] - from[0]) / 2);
  const d = `M ${from[0]} ${from[1]} C ${from[0] + dx} ${from[1]}, ${to[0] - dx} ${to[1]}, ${to[0]} ${to[1]}`;
  return <path className={cx("ds-wire", active && "ds-wire--active")} d={d} stroke={`var(--type-${type})`} />;
}

export function Node({
  className,
  width,
  header,
  onPointerDown,
  title,
  kind,
  x,
  y,
  selected,
  running,
  progress,
  children,
}: {
  className?: string;
  width?: number;
  header?: ReactNode;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  title: string;
  kind?: string;
  x: number;
  y: number;
  selected?: boolean;
  running?: boolean;
  progress?: number;
  children: ReactNode;
}) {
  return (
    <div className={cx("ds-node", className)} style={{ left: x, top: y, width }} data-selected={selected || undefined} data-running={running || undefined} onPointerDown={onPointerDown}>
      {header ?? <div className="ds-node__head" style={{ height: NODE_HEAD_H }}>
        {running && <SparkleLoader size="sm" />}
        <span className="ds-node__title">{title}</span>
        {kind && <span className="ds-node__kind">{kind}</span>}
      </div>}
      {progress !== undefined && (
        <div className="ds-node__progress">
          <div style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="ds-node__body">{children}</div>
    </div>
  );
}

export function Socket({ label, type, dir }: { label: string; type: SocketType; dir: "in" | "out" }) {
  return (
    <div className={cx("ds-socket", `ds-socket--${dir}`)} style={{ ["--port-color" as string]: `var(--type-${type})` }}>
      <span className="ds-socket__port" />
      {label}
    </div>
  );
}

export function Widget({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ds-widget">
      <span className="ds-widget__label">{label}</span>
      <span className="ds-widget__value">{value}</span>
    </div>
  );
}

/* ── Dialog and model option ────────────────────────────────── */

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
  className,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(open, panel, onClose);

  if (!open) return null;
  const content=(
    <div className="ds-dialog__scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("ds-dialog", wide && "ds-dialog--wide", className)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
        <header className="ds-dialog__head">
          <h2 id={titleId} className="ds-dialog__title">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <InDialogContext.Provider value={true}>
          <div className="ds-dialog__body">{children}</div>
        </InDialogContext.Provider>
        {footer && <footer className="ds-dialog__foot">{footer}</footer>}
      </div>
    </div>
  );
  return typeof document === "undefined"?content:createPortal(content,document.body);
}

export type OptionStatus = "ready" | "missing" | "incompatible" | "offline" | "checking";

const STATUS_TEXT: Record<OptionStatus, string> = {
  ready: "Ready",
  missing: "Not installed",
  incompatible: "Needs update",
  offline: "Offline",
  checking: "Checking",
};

/** A selectable model card for the picker. The whole card is the button. */
export function ModelOption({
  title,
  subtitle,
  status,
  selected,
  meta,
  detail,
  onSelect,
  disabled,
}: {
  title: string;
  subtitle: string;
  status: OptionStatus;
  selected: boolean;
  meta?: ReactNode;
  detail?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="ds-option" data-status={status} data-selected={selected}>
      <button type="button" className="ds-option__main" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}>
        <span className="ds-option__head">
          <span className="ds-option__title">{title}</span>
          <span className="ds-option__status">
            {status === "checking" ? <SparkleLoader size="sm" /> : <span className={cx("ds-dot", status === "ready" ? "ds-dot--ok" : "ds-dot--off")} />}
            {STATUS_TEXT[status]}
          </span>
        </span>
        <span className="ds-option__sub">{subtitle}</span>
        {meta && <span className="ds-option__meta">{meta}</span>}
      </button>
      {detail && <div className="ds-option__detail">{detail}</div>}
    </div>
  );
}

/** A copyable shell command or support text, shown in notices that tell the user what to run. */
export function CodeLine({ children, copyLabel = "Copy" }: { children: string; /** What the copy button says, e.g. "Copy details". */ copyLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ds-codeline">
      <code>{children}</code>
      <button
        type="button"
        className="ds-codeline__copy"
        onClick={() => {
          void navigator.clipboard?.writeText(children).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : copyLabel}
      </button>
    </span>
  );
}

/* Hero: the encouraging title over a results pane, with the tool's own clip on the right. Behind the clip, three
   soft accent glows drift slowly (the one place a glow is not an action, rule 55). Without media it is title and text only. */
export function Hero({ title, text, media, stage, accent }: { title: string; text?: string; media?: ReactNode; /** The loop fills the whole band behind the words, slowly drifting; the title rises word by word. */ stage?: boolean; /** One word of the title drawn in the brand yellow. */ accent?: string }) {
  const words = title.split(" ");
  const heading = stage ? words.map((word, i) => <span key={i} className={cx("ds-hero__word", accent && word === accent && "ds-hero__word--accent")} style={{ animationDelay: `${i * 90}ms` }}>{word}</span>) : title;
  if (stage) return (
    <section className="ds-hero ds-hero--stage">
      <div className="ds-hero__bg" aria-hidden>
        {media}
        <span className="ds-hero__aurora" /><span className="ds-hero__aurora" />
        <span className="ds-hero__blur" />
        <span className="ds-hero__veil" />
      </div>
      <div className="ds-hero__copy">
        <h2 className="ds-hero__title">{heading}</h2>
        {text && <p className="ds-hero__text">{text}</p>}
      </div>
    </section>
  );
  return (
    <section className="ds-hero">
      <div className="ds-hero__copy">
        <h2 className="ds-hero__title">{heading}</h2>
        {text && <p className="ds-hero__text">{text}</p>}
      </div>
      {media && (
        <div className="ds-hero__media">
          <span className="ds-hero__glow" aria-hidden /><span className="ds-hero__glow" aria-hidden /><span className="ds-hero__glow" aria-hidden />
          <div className="ds-hero__frame">{media}</div>
        </div>
      )}
    </section>
  );
}

/* FrameStrip: a row of labelled pictures that explain one result, such as what a model was given and what it
   made first. Each picture opens in the full view; the label sits under it as an L3 caption. */
export function FrameStrip({ label, items }: { label: string; items: Array<{ src: string; label: string }> }) {
  return (
    <figure className="ds-framestrip" aria-label={label}>
      <figcaption className="ds-framestrip__title">{label}</figcaption>
      <div className="ds-framestrip__row">
        {items.map((item) => (
          <span key={item.label} className="ds-framestrip__item">
            <img src={item.src} alt={item.label} loading="lazy" />
            <Meta>{item.label}</Meta>
          </span>
        ))}
      </div>
    </figure>
  );
}
