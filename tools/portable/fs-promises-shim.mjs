// Node 12 has fs.promises but not the 'fs/promises' module specifier (Node 14+).
import fs from 'fs';

export const promises = fs.promises;
export default fs.promises;
