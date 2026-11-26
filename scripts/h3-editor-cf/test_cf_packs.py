"""Checks for reference packs. Run with any Python 3: python scripts/h3-editor-cf/test_cf_packs.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_packs  # noqa: E402

CATALOG = [{"id": "e1", "name": "Maya", "kind": "person", "file": "m.png", "version": 2},
           {"id": "e2", "name": "Pier", "kind": "location", "file": "p.png", "version": 1},
           {"id": "e3", "name": "Kip", "kind": "item", "file": "k.png", "version": 1}]


def test_new_overwrite_extend_rename():
    packs, pack = cf_packs.save_pack([], CATALOG, "  Pier  at dusk ", ["e1", "e2", "e1"])
    assert pack["name"] == "Pier at dusk" and pack["members"] == ["e1", "e2"] and pack["version"] == 1
    packs, pack = cf_packs.save_pack(packs, CATALOG, None, ["e3"], pack["id"], "extend")
    assert pack["members"] == ["e1", "e2", "e3"] and pack["version"] == 2 and pack["name"] == "Pier at dusk"
    packs, pack = cf_packs.save_pack(packs, CATALOG, None, ["e2"], pack["id"], "overwrite")
    assert pack["members"] == ["e2"]
    packs, pack = cf_packs.save_pack(packs, CATALOG, "Pier", None, pack["id"], "rename")
    assert pack["name"] == "Pier" and pack["members"] == ["e2"] and len(packs) == 1


def test_refusals():
    for args in [(CATALOG, "", ["e1"]), (CATALOG, "x", []), (CATALOG, "x", ["nope"])]:
        try:
            cf_packs.save_pack([], *args)
        except ValueError:
            continue
        raise AssertionError(args)
    try:
        cf_packs.save_pack([], CATALOG, "x", ["e1"], "kmissing", "overwrite")
    except KeyError:
        pass
    else:
        raise AssertionError("missing pack")


def test_view_and_remove():
    packs, pack = cf_packs.save_pack([], CATALOG, "Scene", ["e1", "e3"])
    shown = cf_packs.view(packs, CATALOG[:1])      # Kip left the catalog
    assert shown[0]["members"][0]["name"] == "Maya" and shown[0]["missing"] == 1
    assert cf_packs.remove_pack(packs, pack["id"]) == []


if __name__ == "__main__":
    for name, test in sorted(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
