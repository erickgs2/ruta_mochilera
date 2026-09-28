import nextConfig from 'eslint-config-next';
import baseConfig from '../../eslint.config.mjs';

const config = [...baseConfig, ...nextConfig];

export default config;
