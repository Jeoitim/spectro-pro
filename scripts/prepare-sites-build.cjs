const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } = require('fs');
const path = require('path');

const distDirectory = path.resolve(__dirname, '..', 'dist');
const clientDirectory = path.join(distDirectory, 'client');

rmSync(clientDirectory, { recursive: true, force: true });
mkdirSync(clientDirectory, { recursive: true });

const copyToClient = (fileName) => {
    const source = path.join(distDirectory, fileName);
    if (existsSync(source)) {
        copyFileSync(source, path.join(clientDirectory, fileName));
    }
};

for (const fileName of [
    'index.html',
    'styles.css',
    'og-image.jpg',
    'main.js',
    'main.js.LICENSE.txt',
    'main.js.map',
]) {
    copyToClient(fileName);
}

const mainBundle = readFileSync(path.join(distDirectory, 'main.js'), 'utf8');
const workerFiles = new Set(mainBundle.match(/[a-f0-9]{20}\.worker\.js/g) || []);
for (const workerFile of workerFiles) {
    copyToClient(workerFile);
    copyToClient(`${workerFile}.map`);
}
