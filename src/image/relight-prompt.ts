/** Interpret common directional and colour words for the schematic guide only. */
export function inferLightGuide(prompt:string){
  const p=prompt.toLowerCase();
  const vertical=/\b(bottom|below|underneath|under|upwards?|uplight(?:ing)?)\b/.test(p)?"bottom":/\b(top|above|overhead|downwards?)\b/.test(p)?"top":"";
  const side=/\bleft\b/.test(p)?"left":/\bright\b/.test(p)?"right":"";
  const depth=/\bfront\b/.test(p)?"front":/\b(back|behind)\b/.test(p)?"back":"";
  const direction=[vertical,depth,side].filter(Boolean).join(" ");
  const temperature=/\b(candle|candlelight)\b/.test(p)?"candle":/\btungsten\b/.test(p)?"tungsten":/\b(golden|golden hour)\b/.test(p)?"golden":/\bblue hour\b/.test(p)?"blue-hour":/\b(daylight|neutral white)\b/.test(p)?"daylight":"auto";
  return {direction:direction?`from the ${direction}`:"from prompt",temperature};
}

/** Only explicit guide adjustments add constraints; the prompt has priority. */
export function relightPrompt(prompt:string,direction?:string,temperature?:string){
  const guide=[direction&&`direction ${direction}`,temperature&&`temperature ${temperature}`].filter(Boolean).join(", ");
  return [prompt.trim(),guide&&`Light guide: ${guide}. Follow the user's written instructions if they differ from the guide.`].filter(Boolean).join("\n\n");
}
