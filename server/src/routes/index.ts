/**
 * Route registration index
 * 
 * Central export point for all HTTP route modules.
 */

export { registerAuthRoutes, getSession, isSessionValid, type TwitchSession } from './auth.js';
