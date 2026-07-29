const path = require('path');

module.exports = {
    entry: './src/index.ts',
    devtool: 'source-map',
    target: 'web',
    output: {
        filename: 'main.js',
        path: path.resolve(__dirname, 'dist'),
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.json'],
        alias: {
            'helper-worker$': path.resolve(__dirname, 'src/workers/helper.worker.ts'),
            'ml-matrix$': path.resolve(__dirname, 'node_modules/ml-matrix/matrix.js'),
        },
    },
    devServer: {
        compress: false,
        host: '127.0.0.1',
        port: 9000,
        static: {
            directory: path.join(__dirname, 'dist'),
        },
    },
    module: {
        rules: [
            {
                test: /\.glsl$/,
                exclude: /node_modules/,
                use: [{ loader: 'webpack-glsl-minify' }],
            },
            {
                test: /\.worker\.ts$/,
                use: [
                    { loader: 'babel-loader' },
                    {
                        loader: 'worker-loader',
                        options: {
                            filename: '[contenthash].worker.js',
                        },
                    },
                ],
            },
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                loader: 'babel-loader',
            },
        ],
    },
};
