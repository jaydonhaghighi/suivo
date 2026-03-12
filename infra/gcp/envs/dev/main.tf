terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.12"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  prefix = "suivo-${var.environment}"
}

resource "google_service_account" "api" {
  account_id   = "${local.prefix}-api"
  display_name = "Suivo API"
}

resource "google_service_account" "worker" {
  account_id   = "${local.prefix}-worker"
  display_name = "Suivo Worker"
}

resource "google_sql_database_instance" "postgres" {
  name             = "${local.prefix}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier = var.db_tier
  }

  deletion_protection = false
}

resource "google_sql_database" "app" {
  name     = "suivo"
  instance = google_sql_database_instance.postgres.name
}

resource "google_redis_instance" "cache" {
  name               = "${local.prefix}-redis"
  tier               = var.redis_tier
  memory_size_gb     = 1
  region             = var.region
  redis_version      = "REDIS_7_0"
  authorized_network = "default"
}

resource "google_storage_bucket" "attachments" {
  name                        = "${var.project_id}-${local.prefix}-attachments"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
}

resource "google_kms_key_ring" "raw" {
  name     = "${local.prefix}-ring"
  location = var.region
}

resource "google_kms_crypto_key" "raw" {
  name            = "${local.prefix}-raw"
  key_ring        = google_kms_key_ring.raw.id
  rotation_period = "7776000s"
}

resource "google_cloud_run_v2_service" "api" {
  name     = "${local.prefix}-api"
  location = var.region

  template {
    service_account = google_service_account.api.email
    containers {
      image = var.api_image
      env {
        name  = "DATABASE_URL"
        value = "postgres://USER:PASSWORD@/${google_sql_database.app.name}"
      }
      env {
        name  = "REDIS_URL"
        value = "redis://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
      }
      env {
        name  = "KMS_PROVIDER"
        value = "gcp"
      }
      env {
        name  = "GCP_KMS_KEY_NAME"
        value = google_kms_crypto_key.raw.id
      }
    }
  }
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "${local.prefix}-worker"
  location = var.region

  template {
    service_account = google_service_account.worker.email
    containers {
      image = var.worker_image
      env {
        name  = "DATABASE_URL"
        value = "postgres://USER:PASSWORD@/${google_sql_database.app.name}"
      }
      env {
        name  = "REDIS_URL"
        value = "redis://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
      }
    }
  }
}

resource "google_cloud_scheduler_job" "stale_trigger" {
  name      = "${local.prefix}-stale-check"
  schedule  = "*/5 * * * *"
  time_zone = "UTC"
  region    = var.region

  http_target {
    uri         = "${google_cloud_run_v2_service.api.uri}/v1/internal/stale-trigger"
    http_method = "POST"
  }
}
