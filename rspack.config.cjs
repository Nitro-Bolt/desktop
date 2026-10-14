const path = require('path');
const rspack = require('@rspack/core');
const autoprefixer = require('autoprefixer');
const postcssImport = require('postcss-import');
const postcssVars = require('postcss-simple-vars');

const base = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: process.env.NODE_ENV === 'production' ? false : 'cheap-module-source-map',
    target: 'web',
    module: {
        rules: [{
            resourceQuery: /service-worker/,
            type: 'asset/resource',
            generator: {filename: 'sw.js'}
        }, {
            resourceQuery: /bytes/,
            type: 'asset/bytes'
        }, {
            resourceQuery: /source/,
            type: 'asset/source'
        }, {
            resourceQuery: /inline/,
            type: 'asset/inline'
        }, {
            test: /\.svg$/i,
            resourceQuery: /recolor/,
            loader: path.resolve(__dirname, 'node_modules/scratch-gui/src/lib/tw-recolor/build.js'),
            type: 'javascript/auto'
        }, {
            test: /\.css$/,
            resourceQuery: /addon-style/,
            loader: 'css-loader',
            options: {exportType: 'string'}
        }, {
            test: /\.(frag|vert)$/,
            type: 'asset/source'
        }, {
            test: /\.jsx?$/,
            resourceQuery: {not: [/service-worker/]},
            type: 'javascript/auto',
            loader: 'babel-loader',
            options: {
                babelrc: false,
                presets: ['@babel/preset-env', '@babel/preset-react']
            }
        }, {
            test: /\.css$/,
            include: /node_modules[\\/]monaco-editor/,
            use: ['style-loader', 'css-loader']
        }, {
            test: /\.css$/,
            exclude: /node_modules[\\/]monaco-editor/,
            resourceQuery: {not: [/addon-style/]},
            use: [{
                loader: 'style-loader'
            }, {
                loader: 'css-loader',
                options: {
                    esModule: false,
                    modules: {
                        localIdentName: '[name]_[local]_[hash:base64:5]',
                        exportLocalsConvention: 'camel-case',
                        namedExport: false
                    },
                    importLoaders: 1
                }
            }, {
                loader: 'postcss-loader',
                options: {
                    postcssOptions: {
                        plugins: [postcssImport, postcssVars, autoprefixer]
                    }
                }
            }]
        }, {
            test: /\.(svg|png|wav|gif|jpg|mp3|woff2?|ttf|hex)$/,
            resourceQuery: {not: [/inline/, /recolor/, /source/, /service-worker/]},
            type: 'asset/resource',
            generator: {filename: 'static/assets/[contenthash][ext]'}
        }]
    },
    plugins: [
        new rspack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
            process: require.resolve('process/browser')
        })
    ],
    resolve: {
        fallback: {
            assert: require.resolve('assert/'),
            events: require.resolve('events/'),
            path: require.resolve('path-browserify'),
            url: require.resolve('url/')
        }
    }
};

module.exports = [{
    ...base,
    output: {
        path: path.resolve(__dirname, 'dist-renderer-rspack/editor/gui'),
        filename: 'index.js',
        chunkFilename: '[name].js',
        publicPath: ''
    },
    entry: './src-renderer-rspack/editor/gui/index.jsx',
    plugins: [
        ...base.plugins,
        new rspack.DefinePlugin({'process.env.ROOT': '""'}),
        new rspack.CopyRspackPlugin({
            patterns: [{
                from: 'node_modules/scratch-blocks/media',
                to: 'static/blocks-media/default'
            }, {
                from: 'node_modules/scratch-blocks/media',
                to: 'static/blocks-media/high-contrast'
            }, {
                from: 'node_modules/scratch-gui/src/lib/themes/blocks/high-contrast-media/blocks-media',
                to: 'static/blocks-media/high-contrast',
                force: true
            }, {
                context: 'src-renderer-rspack/editor/gui/',
                from: '*.html'
            }]
        })
    ],
    resolve: {
        ...base.resolve,
        alias: {
            'scratch-gui$': path.resolve(__dirname, 'node_modules/scratch-gui/src/index.js'),
            'scratch-render-fonts$': path.resolve(__dirname, 'node_modules/scratch-gui/src/lib/tw-scratch-render-fonts')
        }
    }
}, {
    ...base,
    output: {
        path: path.resolve(__dirname, 'dist-renderer-rspack/editor/addons'),
        filename: 'index.js'
    },
    entry: './src-renderer-rspack/editor/addons/index.jsx',
    plugins: [
        ...base.plugins,
        new rspack.CopyRspackPlugin({
            patterns: [{
                context: 'src-renderer-rspack/editor/addons/',
                from: '*.html'
            }]
        })
    ]
}];
