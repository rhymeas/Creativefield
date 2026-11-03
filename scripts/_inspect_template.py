import json, subprocess, re, sys

T = sys.argv[2] if len(sys.argv) > 2 else "."
name = sys.argv[1]
d = json.load(open(f"{T}/{name}.json", encoding="utf-8"))
sgs = {s["id"]: s for s in d.get("definitions", {}).get("subgraphs", [])}
print("==", name, "| top nodes:", len(d["nodes"]), "| subgraphs:", len(sgs))


def short(v):
    if isinstance(v, str):
        return v[:46] + "…" if len(v) > 46 else v
    return v


def dump(nodes, indent, seen):
    for n in nodes:
        t = n["type"]
        w = n.get("widgets_values")
        if isinstance(w, list):
            w = [short(x) for x in w]
        elif isinstance(w, dict):
            w = {k: short(v) for k, v in w.items()}
        label = sgs[t]["name"] + " [SUBGRAPH]" if t in sgs else t
        if t in ("MarkdownNote", "Note"):
            continue
        print(f'{indent}id={n["id"]:>4} {label[:44]:<44} mode={n.get("mode")} widgets={w}')
        for m in n.get("properties", {}).get("models", []) or []:
            seen[m["name"]] = m
        if t in sgs:
            dump(sgs[t]["nodes"], indent + "    ", seen)


seen = {}
dump(d["nodes"], "  ", seen)
for s in sgs.values():
    print("SUBGRAPH", s["name"], "inputs:", [(i["name"], i["type"]) for i in s["inputs"]], "outputs:", [(o["name"], o["type"]) for o in s["outputs"]])
print()
tot = 0
for name_, m in seen.items():
    out = subprocess.run(["curl", "-sIL", "-m", "30", m["url"]], capture_output=True, text=True).stdout
    sz = re.findall(r"(?i)^content-length:\s*(\d+)", out, re.M)
    gb = round(int(sz[-1]) / 1024**3, 2) if sz else None
    print(f'  {m["directory"]:<18} {name_:<62} {gb} GB')
for n in d["nodes"]:
    if n["type"] == "MarkdownNote":
        print("NOTE:", (n["widgets_values"][0] or "")[:700].replace("\n", " "))
        break
