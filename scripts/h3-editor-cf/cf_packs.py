"""CreativeField: reference packs for the H3 Editor (user 2026-11-25, Pad).

A pack is a named set of the cast catalog's entries, kept once per install beside the catalog (_cast/packs.json):
for example "Pier at golden hour" with Maya, Kip, the pier and the light. Saving, overwriting and extending a pack
store its members in the catalog first, through the editor's own catalog operations, so a pack only lists catalog
ids and every project takes its own copies. No Comfy import.
"""
import time
import uuid

PACK_LIMIT = 200
NAME_LIMIT = 80


def clean_name(value):
    name = " ".join(str(value or "").split())[:NAME_LIMIT]
    if not name:
        raise ValueError("a pack needs a name")
    return name


def clean_members(members, catalog):
    """The pack's members as catalog ids, in order, each once; ids the catalog does not hold are refused."""
    known = {entry.get("id") for entry in catalog}
    out = []
    for value in members or []:
        cid = value.get("catalog") if isinstance(value, dict) else value
        if cid not in known:
            raise ValueError("no entry %s in the catalog" % cid)
        if cid not in out:
            out.append(cid)
    if not out:
        raise ValueError("a pack needs at least one reference")
    return out


def save_pack(packs, catalog, name, members, pack_id=None, mode="new"):
    """Save a pack. mode new: a new pack. overwrite: pack_id's members become these. extend: these are added.
    rename: only the name changes. Returns (packs, pack); the version goes up on every change."""
    if mode not in ("new", "overwrite", "extend", "rename"):
        raise ValueError("mode is new, overwrite, extend or rename")
    packs = [dict(p) for p in packs]
    if mode == "new":
        if len(packs) >= PACK_LIMIT:
            raise ValueError("up to %s packs" % PACK_LIMIT)
        pack = {"id": "k" + uuid.uuid4().hex[:8], "version": 0, "members": []}
        packs.append(pack)
    else:
        pack = next((p for p in packs if p.get("id") == pack_id), None)
        if pack is None:
            raise KeyError("no pack %s" % pack_id)
    if name is not None or mode in ("new", "rename"):
        pack["name"] = clean_name(name if name is not None else pack.get("name"))
    if mode in ("new", "overwrite"):
        pack["members"] = clean_members(members, catalog)
    elif mode == "extend":
        pack["members"] = clean_members(list(pack.get("members", [])) + list(members or []), catalog)
    pack["version"] = int(pack.get("version", 0)) + 1
    pack["updated"] = int(time.time())
    return packs, pack


def remove_pack(packs, pack_id):
    if not any(p.get("id") == pack_id for p in packs):
        raise KeyError("no pack %s" % pack_id)
    return [p for p in packs if p.get("id") != pack_id]


def view(packs, catalog):
    """The packs as the editor lists them: each member with its name, kind and picture, and any member the
    catalog no longer holds counted as missing."""
    entries = {e.get("id"): e for e in catalog}
    out = []
    for p in packs:
        members, missing = [], 0
        for cid in p.get("members", []):
            e = entries.get(cid)
            if e is None:
                missing += 1
                continue
            members.append({"catalog": cid, "name": e.get("name", ""), "kind": e.get("kind") or "person",
                            "file": e.get("file"), "subfolder": e.get("subfolder"), "version": e.get("version")})
        out.append({"id": p["id"], "name": p.get("name", ""), "version": p.get("version", 1),
                    "updated": p.get("updated"), "members": members, "missing": missing})
    return out
