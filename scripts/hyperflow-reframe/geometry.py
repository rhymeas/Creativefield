"""Pixel geometry for the reviewed HyperFlow variant of H3 Video Outpaint."""

from dataclasses import dataclass
from fractions import Fraction


CANVASES = {
    "16:9 landscape": (1024, 576),
    "9:16 portrait": (576, 1024),
    "1:1 square": (768, 768),
}
GRID = 16


@dataclass(frozen=True)
class ReframeGeometry:
    width: int
    height: int
    picture_width: int
    picture_height: int
    guide_width: int
    guide_height: int
    left: int
    top: int

    @property
    def right(self):
        return self.width - self.left - self.guide_width

    @property
    def bottom(self):
        return self.height - self.top - self.guide_height

    @property
    def pad_left(self):
        return (self.guide_width - self.picture_width) // 2

    @property
    def pad_top(self):
        return (self.guide_height - self.picture_height) // 2


def plan_geometry(input_width, input_height, target_aspect):
    """Fit the full picture uniformly and align the guide, never crop the source."""
    width, height = CANVASES[target_aspect]
    if min(input_width, input_height) < 1:
        raise ValueError("The source video has no visible picture.")
    if input_width * height == input_height * width:
        raise ValueError("This video already has the selected aspect ratio.")

    # Keep at least one 32 px canvas band even when the ratios nearly match.
    wider_source = input_width * height > input_height * width
    available_width = width if wider_source else width - 2 * GRID
    available_height = height - 2 * GRID if wider_source else height
    scale = min(Fraction(available_width, input_width), Fraction(available_height, input_height))
    picture_width = round(input_width * scale)
    picture_height = round(input_height * scale)
    if min(picture_width, picture_height) < 4 * GRID:
        raise ValueError("The source is too narrow for this output format.")

    guide_width = (picture_width + GRID - 1) // GRID * GRID
    guide_height = (picture_height + GRID - 1) // GRID * GRID
    left = ((width - guide_width) // (2 * GRID)) * GRID
    top = ((height - guide_height) // (2 * GRID)) * GRID
    return ReframeGeometry(width, height, picture_width, picture_height, guide_width, guide_height, left, top)


def fit_frame(frame, geometry):
    """Scale the decoded frame once and extend guide padding with edge pixels."""
    import numpy as np

    resized = frame.reformat(width=geometry.picture_width, height=geometry.picture_height, format="rgb24")
    image = resized.to_ndarray()
    right = geometry.guide_width - geometry.picture_width - geometry.pad_left
    bottom = geometry.guide_height - geometry.picture_height - geometry.pad_top
    return np.pad(image, ((geometry.pad_top, bottom), (geometry.pad_left, right), (0, 0)), mode="edge")
