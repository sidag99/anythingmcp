-- CreateTable
CREATE TABLE "sandbox_scripts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "mcp_server_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "last_run_at" TIMESTAMP(3),
    "last_run_ok" BOOLEAN,
    "last_run_meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "mcp_server_id" TEXT NOT NULL,
    "script_id" TEXT,
    "user_id" TEXT,
    "code" TEXT NOT NULL,
    "args" JSONB,
    "ok" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "result_preview" JSONB,
    "meta" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sandbox_scripts_organization_id_idx" ON "sandbox_scripts"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_scripts_mcp_server_id_name_key" ON "sandbox_scripts"("mcp_server_id", "name");

-- CreateIndex
CREATE INDEX "sandbox_runs_organization_id_created_at_idx" ON "sandbox_runs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "sandbox_runs_mcp_server_id_created_at_idx" ON "sandbox_runs"("mcp_server_id", "created_at");

-- AddForeignKey
ALTER TABLE "sandbox_scripts" ADD CONSTRAINT "sandbox_scripts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_scripts" ADD CONSTRAINT "sandbox_scripts_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "sandbox_scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

