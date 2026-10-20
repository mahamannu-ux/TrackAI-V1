/**
 * Registers Task19b's ten live code answerers (T19.3) in the app registry.
 * Imported once at module load by qa.routes.ts; tests use their own registry.
 */
import { registerAnswerer } from '../answerers';
import { answererQ1 } from './q01';
import { answererQ2 } from './q02';
import { answererQ3 } from './q03';
import { answererQ4 } from './q04';
import { answererQ6 } from './q06';
import { answererQ9 } from './q09';
import { answererQ10 } from './q10';
import { answererQ13 } from './q13';
import { answererQ14 } from './q14';
import { answererQ15 } from './q15';
import { answererQ18 } from './q18';
import { answererQ19 } from './q19';
import { answererQ20 } from './q20';

registerAnswerer('Q1', 'live', answererQ1);
registerAnswerer('Q2', 'live', answererQ2);
registerAnswerer('Q3', 'live', answererQ3);
registerAnswerer('Q4', 'live', answererQ4);
registerAnswerer('Q6', 'live', answererQ6);
registerAnswerer('Q9', 'live', answererQ9);
registerAnswerer('Q10', 'live', answererQ10);
registerAnswerer('Q13', 'live', answererQ13);
registerAnswerer('Q14', 'live', answererQ14);
registerAnswerer('Q15', 'live', answererQ15);
registerAnswerer('Q18', 'live', answererQ18);
registerAnswerer('Q19', 'live', answererQ19);
registerAnswerer('Q20', 'live', answererQ20);
