// dsh-ris-ide — build, verify, publish (Nexus npm hosted), archive the tarball.
//
// Environment (Jenkins credentials / folder env):
//   NEXUS_NPM_REGISTRY  e.g. https://nexus.example.com/repository/npm-releases/
//   NEXUS_NPM_PUBLISH   same repository (may differ from the read registry)
//   NPM_CREDENTIALS     Jenkins username/password credential id for Nexus
// The pipeline reads the version from package.json; a tag build publishes,
// a branch build only produces + archives the tarball.

pipeline {
  agent any

  options {
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '30'))
    disableConcurrentBuilds()
  }

  environment {
    // Keep npm's cache/logs inside the workspace: Jenkins agents often cannot
    // write $HOME, which makes `npm pack` fail with EACCES.
    npm_config_cache = "${WORKSPACE}/.npm-cache"
    npm_config_logs_dir = "${WORKSPACE}/.npm-logs"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        script {
          // No pipeline-utility dependency: ask node for the two fields.
          env.PKG_NAME = sh(returnStdout: true, script: "node -p \"require('./package.json').name\"").trim()
          env.PKG_VERSION = sh(returnStdout: true, script: "node -p \"require('./package.json').version\"").trim()
          currentBuild.displayName = "#${env.BUILD_NUMBER} ${env.PKG_NAME}@${env.PKG_VERSION}"
        }
      }
    }

    stage('Install') {
      steps {
        sh '''
          set -euo pipefail
          node --version
          npm --version
          # devDependencies carry tsdown + @codemirror/* (the chunk's build inputs).
          # Commit a package-lock.json and switch this to `npm ci` once the lock
          # exists in the repo — `npm install` is used while there is none.
          if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
        '''
      }
    }

    stage('Build') {
      steps {
        sh '''
          set -euo pipefail
          # Produces lib/client-codemirror.js (the lazily-loaded editor chunk).
          npm run build
          test -s lib/client-codemirror.js
        '''
      }
    }

    stage('Test') {
      steps {
        sh 'npm test'
      }
    }

    stage('Pack') {
      steps {
        sh '''
          set -euo pipefail
          mkdir -p dist
          npm pack --pack-destination dist
          ls -l dist
        '''
        archiveArtifacts artifacts: 'dist/*.tgz', fingerprint: true
      }
    }

    stage('Publish to Nexus') {
      when { buildingTag() }
      steps {
        withCredentials([usernamePassword(credentialsId: 'NPM_CREDENTIALS', usernameVariable: 'NEXUS_USER', passwordVariable: 'NEXUS_PASS')]) {
          sh '''
            set -euo pipefail
            # Nexus hosted npm repo; the auth lines go to a throwaway .npmrc so
            # nothing secret is committed or persisted in the profile.
            cat > .npmrc <<NPMRC
registry=${NEXUS_NPM_PUBLISH}
//${NEXUS_NPM_PUBLISH#https://}:_auth=\\$(printf '%s:%s' "$NEXUS_USER" "$NEXUS_PASS" | base64 -w0)
always-auth=true
NPMRC
            npm publish --registry "$NEXUS_NPM_PUBLISH"
            rm -f .npmrc
          '''
        }
      }
    }
  }

  post {
    success {
      echo "Built ${env.PKG_NAME}@${env.PKG_VERSION}; tarball archived under dist/"
    }
  }
}
