const path = require('path');
const rspack = require('@rspack/core');
const autoprefixer = require('autoprefixer');
const postcssImport = require('postcss-import');
const postcssSimpleVars = require('postcss-simple-vars');

const scratchGuiPath = path.dirname(require.resolve('scratch-gui/package.json'));
const scratchGuiNodeModules = path.join(scratchGuiPath, 'node_modules');
const scratchBlocksPath = path.dirname(require.resolve('scratch-blocks/package.json', {
    paths: [scratchGuiPath]
}));

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
                    presets: [
                        ['@babel/preset-env', {modules: 'commonjs'}],
                        '@babel/preset-react'
                    ]
                }
            },
            {
                test: /\.(svg|png|wav|gif|jpg|mp3|woff2|woff|ttf|hex)$/,
                type: 'asset/resource',
                generator: {
                    filename: 'static/assets/[name].[contenthash][ext]'
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
                            esModule: false,
                            modules: {
                                exportLocalsConvention: 'camel-case',
                                localIdentName: '[name]_[local]_[hash:base64:5]'
                            },
                            importLoaders: 1,
                        }
                    },
                    {
                        loader: 'postcss-loader',
                        options: {
                            postcssOptions: {
                                plugins: [
                                    postcssImport(),
                                    postcssSimpleVars(),
                                    autoprefixer()
                                ]
                            }
                        }
                    }
                ]
            }
        ]
    },
    resolve: {
        // npm does not hoist dependencies from packages installed with `npm link`.
        // Fall back to the GUI's dependencies so linking a local GUI works without
        // separately linking React, Redux, scratch-blocks, and other dependencies.
        modules: [
            path.resolve(__dirname, 'node_modules'),
            scratchGuiNodeModules,
            'node_modules'
        ],
        fallback: {
            buffer: require.resolve('buffer/'),
            events: require.resolve('events/'),
            path: require.resolve('path-browserify'),
            url: require.resolve('url/')
        }
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
            new rspack.DefinePlugin({
                'process.env.ROOT': '""'
            }),
            new rspack.CopyRspackPlugin({
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
                'istextorbinary$': path.join(scratchGuiNodeModules, 'istextorbinary/edition-browsers/index.js'),
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
            new rspack.CopyRspackPlugin({
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
