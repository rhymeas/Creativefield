"""CreativeField: reference kinds for the H3 Editor's cast (user 2026-11-25).

The editor treats every cast picture as a person. A cast member now has a kind:

    person    a <Subject n>: identity, face, hair and body proportions kept
    item      a <Subject n>: an object, its shape, proportions, colours, materials and details kept
    location  pictures of the place: environment, architecture and layout kept, the camera free
    style     pictures of the look: light, colours, grade and rendering followed, their content never shown
    outfit    pictures of clothing for the person in the shot; not another person

Only a clip that has a cast member of another kind than person uses compose_reference_prompt below; a clip of
people keeps the editor's own prompt word for word. The structure is the editor's (prompting.py, MiniMax's
full-reference guide); the role wording is adapted from BExplains MiniMax H3 RefPacks (MIT,
github.com/BExplains/ComfyUI-MiniMax-H3-RefPacks, core.py at a93dc65). GPL-3.0, like the editor.
"""
import re

try:
    from .prompting import DEFAULT_SOUND, VOICE, dialogue_line
except ImportError:
    from prompting import DEFAULT_SOUND, VOICE, dialogue_line

KINDS = ("person", "item", "location", "style", "outfit")
SUBJECT_KINDS = ("person", "item")


def kind_of(member):
    kind = member.get("kind") if isinstance(member, dict) else None
    return kind if kind in KINDS else "person"


def clean_kind(value):
    """The kind a cast member is stored with; empty is a person."""
    if value in (None, ""):
        return "person"
    if value not in KINDS:
        raise ValueError("a cast member's kind is one of %s" % ", ".join(KINDS))
    return value


def uses_kinds(subjects):
    return any(kind_of(s) != "person" for s in subjects or ())


def _join(tags):
    return tags[0] if len(tags) == 1 else ", ".join(tags[:-1]) + " and " + tags[-1]


def _what(member):
    return (member.get("description") or member["name"]).strip().rstrip(".")


def plan(subjects, first_frame=False, last_frame=False):
    """Each member with its kind, its <Picture n> tags and, for a person or item, its <Subject n> number."""
    picture = int(bool(first_frame)) + int(bool(last_frame))
    subject = 0
    rows = []
    for member in subjects:
        tags = []
        for _ in range(max(1, int(member.get("picture_count") or 1))):
            picture += 1
            tags.append("<Picture %s>" % picture)
        kind = kind_of(member)
        number = None
        if kind in SUBJECT_KINDS:
            subject += 1
            number = subject
        rows.append({"member": member, "kind": kind, "tags": tags, "where": _join(tags), "subject": number})
    return rows


def _alias(row):
    """What @Name becomes in the shot text."""
    if row["subject"]:
        return "<Subject %s>" % row["subject"]
    if row["kind"] == "location":
        return "the location shown in " + row["where"]
    if row["kind"] == "outfit":
        return "the outfit in " + row["where"]
    return "the look of " + row["where"]


def tag(text, rows):
    """@Name to its reference, longest names first, so @Old Tom wins over @Old."""
    for row in sorted(rows, key=lambda r: -len(r["member"]["name"])):
        text = re.sub("@" + re.escape(row["member"]["name"]), _alias(row), text, flags=re.IGNORECASE)
    return text


def definition(row):
    what, where, kind = _what(row["member"]), row["where"], row["kind"]
    if kind == "person":
        return ("<Subject %s> is %s, one person whose identity, facial features, hairstyle and body proportions are "
                "shown in %s." % (row["subject"], what, where))
    if kind == "item":
        return ("<Subject %s> is %s, one object shown in %s; preserve its shape, proportions, colors, materials and "
                "distinctive details." % (row["subject"], what, where))
    if kind == "location":
        return "%s defines the location, environment and architecture: %s." % (where, what)
    if kind == "outfit":
        return "%s supplies an outfit reference (%s); it does not define an additional person." % (where, what)
    return ("%s supplies the visual style reference (%s): its lighting, colors, grade and rendering, without defining "
            "an additional subject." % (where, what))


def retention(row):
    where, kind = row["where"], row["kind"]
    if kind == "person":
        return "<Subject %s> (appears in [Shot 1]): fully_preserved - their identity and appearance are retained." % row["subject"]
    if kind == "item":
        return ("<Subject %s> (appears in [Shot 1]): fully_preserved - its shape, proportions, colors, materials and "
                "details are retained." % row["subject"])
    if kind == "location":
        return ("%s (location of [Shot 1]): partially_preserved - the place, its architecture, materials and layout are "
                "kept; the camera may see it from another angle." % where)
    if kind == "outfit":
        return "%s (outfit): fully_preserved - the clothing is worn as shown." % where
    return ("%s (look of [Shot 1]): reference - light direction and quality, colour palette and grade follow it; "
            "nothing it shows appears in the shot." % where)


def unmentioned(rows, body):
    """Sentences for references the shot text does not name, so every chosen picture is used."""
    people = [r for r in rows if r["kind"] == "person"]
    out = []
    missing = ["<Subject %s>" % r["subject"] for r in rows if r["subject"] and "<Subject %s>" % r["subject"] not in body]
    if missing:
        out.append(" and ".join(missing) + (" appears in the shot." if len(missing) == 1 else " appear in the shot."))
    for row in rows:
        if row["subject"] or row["where"] in body or _alias(row) in body:
            continue
        if row["kind"] == "location":
            out.append("The shot takes place in the location shown in %s." % row["where"])
        elif row["kind"] == "style":
            out.append("The light, colours and grade follow %s." % row["where"])
        elif row["kind"] == "outfit" and len(people) == 1:
            out.append("<Subject %s> wears the outfit in %s." % (people[0]["subject"], row["where"]))
    return out


def compose_reference_prompt(style, action, subjects=(), first_frame=False, last_frame=False,
                             camera="", speaker="", dialogue="", sound="", music="", language="English", voice=None):
    """The editor's compose_reference_prompt with reference kinds. voice {"subject": n} counts all cast members in
    the order given, as the editor numbers them; it is mapped to that member's Subject number here."""
    rows = plan(list(subjects), first_frame, last_frame)
    first_tag = "<Picture 1>" if first_frame else None
    last_tag = ("<Picture 2>" if first_frame else "<Picture 1>") if last_frame else None
    definitions, kept = [], []
    if first_tag:
        definitions.append("%s is the first frame of [Shot 1]." % first_tag)
        kept.append("%s ([Shot 1] first frame): fully_preserved - the shot begins exactly on this frame." % first_tag)
    if last_tag:
        definitions.append("%s is the last frame of [Shot 1]." % last_tag)
        kept.append("%s ([Shot 1] last frame): fully_preserved - the shot ends exactly on this frame." % last_tag)
    for row in rows:
        definitions.append(definition(row))
        kept.append(retention(row))

    if voice and voice.get("subject"):
        index = int(voice["subject"]) - 1
        row = rows[index] if 0 <= index < len(rows) else None
        voice = {"subject": row["subject"]} if row and row["subject"] else {"description": _what(row["member"]) if row else "the speaker"}
    voiced = bool(voice) and bool(dialogue.strip())
    if voiced:
        owner = ("<Subject %s>" % voice["subject"]) if voice.get("subject") else (voice.get("description") or "the speaker").strip().rstrip(".")
        owner = owner if owner.startswith("<") else owner[:1].lower() + owner[1:]
        definitions.append("%s is the voice-timbre reference for %s (S1)." % (VOICE, owner))
        kept.append("%s: reference - the target speaker follows %s's voice timbre and delivery without copying the original signal." % (VOICE, VOICE))

    tasks = []
    if first_tag or last_tag:
        tasks.append("keyframe completion")
    if rows:
        tasks.append("reference generation")
    if voiced:
        tasks.append("audio reference")
    body = tag(action.strip(), rows)
    lead = " ".join(unmentioned(rows, body))
    shot = (lead + " " + body).strip() if lead else body
    if first_tag:
        shot = "The shot begins from %s. %s" % (first_tag, shot)
    if camera.strip():
        shot += " " + tag(camera.strip(), rows)
    if dialogue.strip():
        shot += " " + dialogue_line(tag(speaker, rows), dialogue, language, voice=voiced)
    if last_tag:
        shot += " The shot ends on %s." % last_tag

    sentence = re.split(r"(?<=[.!?])\s", body, maxsplit=1)[0]
    look = (style or "Live-action, cinematic").strip().rstrip(",.")
    return "\n\n".join([
        "subject_definitions:\n" + "\n".join(definitions),
        "summary:\n[%s] %s" % (" + ".join(tasks), sentence),
        "retention_analysis:\n" + "\n".join(kept),
        "detailed_description:\nThe target video is in a %s style.\n[Shot 1] %s" % (look.lower(), shot),
        "overall_soundscape:\n" + (sound.strip() or DEFAULT_SOUND),
        "non_diegetic_music:\n" + (music.strip() or "N/A"),
    ])
