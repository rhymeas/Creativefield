import { Meta } from "../ds";
import "./mask-how-it-works.css";

/** Three compact animated scenes for the video-mask explainer. */
export function MaskHowItWorks({ trackingAvailable = false }: { trackingAvailable?: boolean } = {}) {
  return <div className="cf-mask-guide">
    <div className="cf-mask-guide__steps">
      <figure className="cf-mask-guide__step">
        <svg viewBox="0 0 160 88" aria-hidden="true">
          <rect x=".5" y=".5" width="159" height="87" rx="14" fill="var(--surface-control)" stroke="var(--line-hairline)" />
          <rect x="12" y="14" width="136" height="54" rx="8" fill="var(--surface-panel)" stroke="var(--line-hairline)" />
          <line x1="57" y1="14" x2="57" y2="68" stroke="var(--line-hairline)" />
          <line x1="103" y1="14" x2="103" y2="68" stroke="var(--line-hairline)" />
          <path d="M75 32l13 10-13 10z" fill="var(--text-primary)" opacity=".8">
            <animate attributeName="opacity" values=".35;.9;.35" dur="3s" repeatCount="indefinite" />
          </path>
          <rect x="12" y="74" width="136" height="4" rx="2" fill="var(--line-hairline)" />
          <rect x="12" y="74" width="22" height="4" rx="2" fill="var(--accent)">
            <animate attributeName="width" values="22;126;22" dur="5s" repeatCount="indefinite" />
          </rect>
          <rect x="12" y="10" width="2" height="62" rx="1" fill="var(--accent)" opacity=".85">
            <animate attributeName="x" values="12;146;12" dur="5s" repeatCount="indefinite" />
          </rect>
        </svg>
        <figcaption><Meta parts={["1", "Choose the clip"]} /></figcaption>
      </figure>

      <figure className="cf-mask-guide__step">
        <svg viewBox="0 0 160 88" aria-hidden="true">
          <rect x=".5" y=".5" width="159" height="87" rx="14" fill="var(--surface-control)" stroke="var(--line-hairline)" />
          <rect x="10" y="12" width="66" height="58" rx="8" fill="var(--surface-panel)" stroke="var(--line-hairline)" />
          <path d="M18 56l16-20 11 12 8-7 15 15z" fill="var(--surface-subtle)" />
          <path d="M77 41h6m-2-2 2 2-2 2" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="84" y="12" width="66" height="58" rx="8" fill="var(--surface-page)" stroke="var(--line-strong)" />
          <ellipse cx="117" cy="42" rx="17" ry="18" fill="var(--text-primary)" opacity=".9">
            <animate attributeName="ry" values="4;18;18;4" dur="4s" repeatCount="indefinite" />
            <animate attributeName="rx" values="5;17;17;5" dur="4s" repeatCount="indefinite" />
          </ellipse>
          <rect x="10" y="75" width="140" height="4" rx="2" fill="var(--line-hairline)" />
        </svg>
        <figcaption><Meta parts={["2", trackingAvailable ? "Describe the object and review its mask" : "Add a mask video"]} /></figcaption>
      </figure>

      <figure className="cf-mask-guide__step">
        <svg viewBox="0 0 160 88" aria-hidden="true">
          <rect x=".5" y=".5" width="159" height="87" rx="14" fill="var(--surface-control)" stroke="var(--line-hairline)" />
          <rect x="8" y="14" width="50" height="58" rx="8" fill="var(--surface-panel)" stroke="var(--line-hairline)" />
          <rect x="16" y="24" width="34" height="5" rx="2.5" fill="var(--text-secondary)" opacity=".65" />
          <rect x="16" y="35" width="28" height="4" rx="2" fill="var(--line-strong)" />
          <rect x="16" y="44" width="22" height="4" rx="2" fill="var(--line-strong)" />
          <path d="M62 41h8m-3-2 3 2-3 2" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="76" y="12" width="76" height="58" rx="8" fill="var(--surface-panel)" stroke="var(--line-hairline)" />
          <path d="M84 58l17-21 11 12 9-8 21 17z" fill="var(--surface-subtle)" />
          <ellipse cx="114" cy="41" rx="13" ry="16" fill="var(--text-primary)" opacity=".65" />
          <ellipse cx="114" cy="41" rx="13" ry="16" fill="var(--accent)" opacity="0">
            <animate attributeName="opacity" values="0;0;.95;.95;0" dur="4s" repeatCount="indefinite" />
          </ellipse>
          <rect x="8" y="75" width="144" height="4" rx="2" fill="var(--line-hairline)" />
        </svg>
        <figcaption><Meta parts={["3", "Describe the white area"]} /></figcaption>
      </figure>
    </div>
    <Meta>The mask is its own black-and-white video. White marks the edit area. Black areas use the source in the final composite; the encoded export can still have pixel differences. CreativeField checks size, length and frame rate against the clip.</Meta>
    <Meta>{trackingAvailable ? "Describe the object to track it, then review the generated mask before using it. You can also upload a matching mask video." : "Upload a matching black-and-white mask video. Object tracking appears when a compatible local worker is ready."}</Meta>
  </div>;
}
