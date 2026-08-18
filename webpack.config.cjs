const fs = require('fs');
const path = require('path');
const Module = require('module');

const scratchGuiPath = path.dirname(require.resolve('scratch-gui/package.json'));
const scratchGuiNodeModules = path.join(scratchGuiPath, 'node_modules');

// pnpm links packages without installing their dependencies in the consuming
// project. Discover the node_modules directories belonging to linked packages
// so webpack can resolve the complete local dependency tree.
const nodeModulePaths = [path.resolve(__dirname, 'node_modules')];
const visitedNodeModules = new Set();
const collectNodeModules = nodeModulesPath => {
    let realNodeModulesPath;
    try {
        realNodeModulesPath = fs.realpathSync(nodeModulesPath);
    } catch {
        return;
    }
    if (visitedNodeModules.has(realNodeModulesPath)) return;
    visitedNodeModules.add(realNodeModulesPath);
    nodeModulePaths.push(realNodeModulesPath);

    let entries;
    try {
        entries = fs.readdirSync(realNodeModulesPath, {withFileTypes: true});
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const packagePath = path.join(realNodeModulesPath, entry.name);
        const packagePaths = entry.name.startsWith('@') && entry.isDirectory() ?
            fs.readdirSync(packagePath)
                .filter(packageName => !packageName.startsWith('.'))
                .map(packageName => path.join(packagePath, packageName)) :
            [packagePath];
        for (const linkedPackagePath of packagePaths) {
            collectNodeModules(path.join(linkedPackagePath, 'node_modules'));
        }
    }
};

collectNodeModules(scratchGuiNodeModules);

// Loaders in linked packages may call require() themselves. NODE_PATH makes
// the same dependency locations available to those loaders as well.
process.env.NODE_PATH = [
    ...nodeModulePaths,
    process.env.NODE_PATH
].filter(Boolean).join(path.delimiter);
Module._initPaths();

const {DefinePlugin, NormalModuleReplacementPlugin} = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const MonacoWebpackPlugin = require(require.resolve('monaco-editor-webpack-plugin', {
    paths: [__dirname, scratchGuiPath]
}));
const scratchBlocksPath = path.dirname(require.resolve('scratch-blocks/package.json', {
    paths: [scratchGuiPath]
}));
const htmlparser2Path = path.dirname(require.resolve('htmlparser2/package.json', {
    paths: [scratchGuiPath]
}));

const legacyHtmlparser2Plugin = () => new NormalModuleReplacementPlugin(
    /^(domhandler|domutils|domelementtype|entities)$/,
    resource => {
        const context = String(resource.context || '').replace(/\\/g, '/');
        if (!context.includes('/htmlparser2/lib')) return;
        resource.request = path.join(htmlparser2Path, 'node_modules', resource.request);
    }
);

const base = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: process.env.NODE_ENV === 'production' ? false : 'cheap-source-map',
    target: 'web',
    module: {
        rules: [
            {
                test: /\.jsx?$/,
                loader: 'babel-loader',
                options: {
                    presets: ['@babel/preset-env', '@babel/preset-react']
                }
            },
            {
                test: /\.(svg|png|wav|gif|jpg|mp3|woff2|woff|ttf|hex)$/,
                loader: 'file-loader',
                options: {
                    outputPath: 'static/assets/',
                    esModule: false
                }
            },
            {
                test: /\.css$/,
                include: /node_modules[\\/]monaco-editor/,
                use: [
                    {
                        loader: 'style-loader'
                    },
                    {
                        loader: 'css-loader'
                    }
                ]
            },
            {
                test: /\.css$/,
                exclude: /node_modules[\\/]monaco-editor/,
                use: [
                    {
                        loader: 'style-loader'
                    },
                    {
                        loader: 'css-loader',
                        options: {
                            modules: true,
                            importLoaders: 1,
                            localIdentName: '[name]_[local]_[hash:base64:5]',
                            camelCase: true
                        }
                    },
                    {
                        loader: 'postcss-loader',
                        options: {
                            postcssOptions: {
                                plugins: [
                                    'postcss-import',
                                    'postcss-simple-vars',
                                    'autoprefixer'
                                ]
                            }
                        }
                    }
                ]
            }
        ]
    },
    resolve: {
        modules: nodeModulePaths
    },
    resolveLoader: {
        modules: nodeModulePaths
    }
};

module.exports = [
    {
        ...base,
        output: {
            path: path.resolve(__dirname, 'dist-renderer-webpack/editor/gui'),
            filename: 'index.js',
            chunkFilename: '[name].js',
            publicPath: ''
        },
        entry: './src-renderer-webpack/editor/gui/index.jsx',
        plugins: [
            legacyHtmlparser2Plugin(),
            new DefinePlugin({
                'process.env.ROOT': '""'
            }),
            new MonacoWebpackPlugin(),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: path.join(scratchBlocksPath, 'media'),
                        to: 'static/blocks-media/default'
                    },
                    {
                        from: path.join(scratchBlocksPath, 'media'),
                        to: 'static/blocks-media/high-contrast'
                    },
                    {
                        from: 'node_modules/scratch-gui/src/lib/themes/blocks/high-contrast-media/blocks-media',
                        to: 'static/blocks-media/high-contrast',
                        force: true
                    },
                    {
                        context: 'src-renderer-webpack/editor/gui/',
                        from: '*.html'
                    }
                ]
            })
        ],
        resolve: {
            ...base.resolve,
            alias: {
                'scratch-gui$': path.resolve(__dirname, 'node_modules/scratch-gui/src/index.js'),
                'scratch-render-fonts$': path.resolve(__dirname, 'node_modules/scratch-gui/src/lib/tw-scratch-render-fonts'),
            }
        }
    },

    {
        ...base,
        output: {
            path: path.resolve(__dirname, 'dist-renderer-webpack/editor/addons'),
            filename: 'index.js'
        },
        entry: './src-renderer-webpack/editor/addons/index.jsx',
        plugins: [
            legacyHtmlparser2Plugin(),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        context: 'src-renderer-webpack/editor/addons/',
                        from: '*.html'
                    }
                ]
            })
        ]
    }
];
