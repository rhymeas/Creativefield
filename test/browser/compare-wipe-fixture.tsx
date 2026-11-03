import {createRoot} from 'react-dom/client';
import {CompareWipe} from '../../src/ds/PrecisionCompare';
import '../../src/ds/tokens.css';import '../../src/ds/components.css';
createRoot(document.getElementById('root')!).render(<div style={{width:600}}><CompareWipe before="/examples/pool/img-16.webp" after="/examples/pool/img-16.webp"/></div>);
