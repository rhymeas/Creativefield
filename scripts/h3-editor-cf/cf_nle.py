"""CreativeField: an editable export of the H3 Editor cut for DaVinci Resolve and Premiere Pro, as FCP 7 XML (xmeml 5).

V1 holds the timeline's clips with their in and out points and speed, V2 the rendered VFX clips (titles). A1 carries
each clip's own sound (when its file has one); the extra sounds (music, effects) get a stereo track per lane, with their level and fades.
Grading is not part of FCP 7 XML: each clip's match and look LUTs are copied beside it and named in the clip's notes.
Pure functions; cf_api.export_nle gathers the files. GPL-3.0, like the editor.
"""
import math
import os
import urllib.parse
from xml.sax.saxutils import escape

FPS = 24


def _url(path):
    path = os.path.abspath(path).replace("\\", "/")
    if not path.startswith("/"):
        path = "/" + path
    return "file://localhost" + urllib.parse.quote(path, safe="/:")


def _rate():
    return "<rate><timebase>%d</timebase><ntsc>FALSE</ntsc></rate>" % FPS


def _db(gain):
    return -96.0 if gain <= 0 else 20 * math.log10(gain)


class _Files:
    """Each media file is described once (with its length); later uses only point at it."""

    def __init__(self):
        self.ids, self.parts = {}, []

    def ref(self, path, frames, audio=True, video=True):
        """The full description the first time, the id after that (Premiere 2026 crashed on repeated descriptions)."""
        if path in self.ids:
            return '<file id="%s"/>' % self.ids[path]
        self.ids[path] = "file-%d" % (len(self.ids) + 1)
        media = ""
        if video:
            media += "<video><samplecharacteristics>%s<width>1920</width><height>1088</height></samplecharacteristics></video>" % _rate()
        if audio:
            media += "<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>"
        # A source timecode: Resolve matches clips to files by reel, timecode and file name, and left clip audio offline
        # without one.
        timecode = "<timecode>%s<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>" % _rate()
        return ('<file id="%s"><name>%s</name><pathurl>%s</pathurl>%s<duration>%d</duration>%s<media>%s</media></file>'
                % (self.ids[path], escape(os.path.basename(path)), escape(_url(path)), _rate(), frames, timecode, media))


def _speed_filter(speed):
    if abs(speed - 1) < 1e-6:
        return ""
    return ("<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory>"
            "<effecttype>motion</effecttype><mediatype>video</mediatype>"
            "<parameter><parameterid>speed</parameterid><name>speed</name><value>%.2f</value></parameter>"
            "<parameter><parameterid>reverse</parameterid><name>reverse</name><value>FALSE</value></parameter>"
            "</effect></filter>" % (speed * 100))


def _level_filter(gain, fade_in=0.0, fade_out=0.0, frames=0):
    keys = ""
    if fade_in or fade_out:
        points = []
        if fade_in:
            points += [(0, 0.0), (int(round(fade_in * FPS)), gain)]
        if fade_out:
            points += [(frames - int(round(fade_out * FPS)), gain), (frames, 0.0)]
        keys = "".join("<keyframe><when>%d</when><value>%.4f</value></keyframe>" % p for p in points)
    return ("<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory>"
            "<effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid>"
            "<name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>%.4f</value>%s</parameter>"
            "</effect></filter>" % (gain, keys))


def build(project, title, clips, sounds, effects):
    """FCP 7 XML text.

    clips:   [{"name", "path", "frames" (file length), "start", "in", "out", "speed", "has_audio", "note"}] in timeline order
    sounds:  [{"name", "path", "frames" (file length), "start", "offset", "length", "gain", "lane", "fade_in", "fade_out"}]
    effects: [{"name", "path", "frames", "start", "length"}]
    """
    files, end = _Files(), 0
    v1, v2, a1 = [], [], []
    for n, c in enumerate(clips):
        length = int(round((c["out"] - c["in"]) / c["speed"]))
        start, stop = c["start"], c["start"] + length
        end = max(end, stop)
        ident = "clip-%d" % (n + 1)
        links = '<link><linkclipref>%s</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>%d</clipindex></link>' % (ident, n + 1)
        if c.get("has_audio"):
            links += ('<link><linkclipref>%s-a</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex>'
                      '<clipindex>%d</clipindex><groupindex>1</groupindex></link>' % (ident, len(a1) + 1))
        note = "<comments><mastercomment1>%s</mastercomment1></comments>" % escape(c["note"]) if c.get("note") else ""
        v1.append('<clipitem id="%s">' % ident + '<name>%s</name><enabled>TRUE</enabled><duration>%d</duration>%s<start>%d</start><end>%d</end>'
                  '<in>%d</in><out>%d</out>%s%s%s%s</clipitem>'
                  % (escape(c["name"]), c["frames"], _rate(), start, stop, c["in"], c["out"],
                     files.ref(c["path"], c["frames"], audio=bool(c.get("has_audio"))), _speed_filter(c["speed"]), links, note))
        if c.get("has_audio"):
            # One stereo clip on A1 per picture clip, linked to it.
            a1.append('<clipitem id="%s-a">' % ident + '<name>%s</name><enabled>TRUE</enabled><duration>%d</duration>%s<start>%d</start>'
                      '<end>%d</end><in>%d</in><out>%d</out>%s<sourcetrack><mediatype>audio</mediatype>'
                      '<trackindex>1</trackindex></sourcetrack>%s%s</clipitem>'
                      % (escape(c["name"]), c["frames"], _rate(), start, stop, c["in"], c["out"],
                         files.ref(c["path"], c["frames"]), _speed_filter(c["speed"]), links))
    for n, e in enumerate(effects):
        v2.append('<clipitem id="vfx-%d"><name>%s</name><enabled>TRUE</enabled><duration>%d</duration>%s<start>%d</start><end>%d</end>'
                  '<in>0</in><out>%d</out>%s</clipitem>'
                  % (n + 1, escape(e["name"]), e["frames"], _rate(), e["start"], e["start"] + e["length"], e["length"],
                     files.ref(e["path"], e["frames"], audio=False)))
    # The editor lets sounds overlap on one lane; an NLE track cannot hold that (Resolve trimmed and dropped them),
    # so each lane is spread over as many tracks as its overlaps need.
    packed = []     # [(lane, [end of last sound], [clipitems])]
    for n, s in enumerate(sorted(sounds, key=lambda s: (s["lane"], s["start"]))):
        first = int(round(s["offset"] * FPS))
        item = ('<clipitem id="sound-%d"><name>%s</name><enabled>TRUE</enabled><duration>%d</duration>%s<start>%d</start><end>%d</end>'
                '<in>%d</in><out>%d</out>%s<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>%s</clipitem>'
                % (n + 1, escape(s["name"]), s["frames"], _rate(), s["start"], s["start"] + s["length"], first, first + s["length"],
                   files.ref(s["path"], s["frames"], video=False), _level_filter(s["gain"], s.get("fade_in", 0), s.get("fade_out", 0), s["length"])))
        room = next((row for row in packed if row[0] == s["lane"] and row[1][0] <= s["start"]), None)
        if room is None:
            room = (s["lane"], [0], [])
            packed.append(room)
        room[1][0] = s["start"] + s["length"]
        room[2].append(item)
    track = lambda items: "<track>%s</track>" % "".join(items)
    audio_tracks = track(a1) + "".join(track(row[2]) for row in packed)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="sequence-1">'
            "<name>%s</name><duration>%d</duration>%s<timecode>%s<string>00:00:00:00</string><frame>0</frame>"
            "<displayformat>NDF</displayformat></timecode><media><video><format><samplecharacteristics>%s<width>1920</width>"
            "<height>1088</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>%s%s</video>"
            "<audio><numOutputChannels>2</numOutputChannels>%s</audio></media></sequence></xmeml>\n"
            % (escape(title), end, _rate(), _rate(), _rate(), track(v1), track(v2) if v2 else "", audio_tracks))
