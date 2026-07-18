# ============================================================================
# Stage 1: Builder
# Install dependencies and compile TypeScript to JavaScript
# ============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first
COPY package.json ./

# MONOREPO FIX: Use standard install instead of strict npm ci 
# This automatically handles the missing lockfile inside the container
RUN npm install

# Copy source code and TypeScript config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → JavaScript
RUN npm run build

# ============================================================================
# Stage 2: Runner
# Minimal production image with only compiled JS and production dependencies
# ============================================================================
FROM node:20-alpine AS runner

WORKDIR /app

# Copy package files
COPY package.json ./

# MONOREPO FIX: Install production dependencies only without a lockfile requirement
RUN npm install --omit=dev

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Cloud Run expects port 8080 by default
EXPOSE 8080

# Run the compiled server
CMD ["node", "dist/index.js"]

