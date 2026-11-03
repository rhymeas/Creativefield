import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {UploadSlot} from '../../src/ds';
import '../../src/ds/tokens.css';import '../../src/ds/components.css';
function Fixture(){const [result,setResult]=useState('empty');return <main style={{width:320,padding:20}}><UploadSlot label="Filled reference" hint="" accept="image/png" kinds={['image']} tile preview="/examples/pool/img-04.webp" onFile={file=>setResult(`filled:${file?.name}`)}/><UploadSlot label="Empty reference" hint="" accept="image/png" kinds={['image']} onFile={file=>setResult(`empty:${file?.name}`)}/><output>{result}</output><textarea aria-label="Prompt"/></main>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
