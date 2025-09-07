FROM node:18

# Install Chromium and other dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package.json package-lock.json ./

# Install project dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Set environment variable for Puppeteer to find the installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Expose the port your Express app listens on
EXPOSE 3001

# Start the application
CMD ["npm", "start"]