# Two video-frame test

Experimental SCAIL video-model path for the local two-character Replace panel.
The optional scene-frame experiment is independent and needs no user approval.

- Source preparation makes exactly five frames at24fps with FFmpeg. Server admission rejects longer or differently timed clips before cleaning or inference.
- Overlay-cleaning admission remains strict and operates on that short source.
- The native graph caps driving images before GPU tracking, samples one five-frame temporal window, and decodes the video latent.
- PNG outputs are decoder indices1 and4 (displayed as video frames2 and5), rather than reference images or masks.
- No video encoder, continuation window or upscale is retained.

Five is the smallest4n+1 window with two output positions after frame zero. This is an appearance/conditioning probe; it cannot establish longer-term motion stability. The first0.1.0 run produced two PNGs, but showed poor conditioning and residual graphics. Version0.1.1 corrects the probe's driving selector to include both people; that correction has CPU tests and is not yet GPU-qualified.


