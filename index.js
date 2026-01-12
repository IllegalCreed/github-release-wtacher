const axios = require("axios");
const Database = require("better-sqlite3");
const schedule = require("node-schedule");
const { OpenAI } = require("openai");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ============ 配置校验 ============
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;

if (!GITHUB_TOKEN) {
  console.error("❌ 请在 .env 文件中配置 GITHUB_TOKEN");
  process.exit(1);
}
if (!DASHSCOPE_API_KEY) {
  console.error(
    "❌ 请在 .env 文件中配置 DASHSCOPE_API_KEY（通义千问的 API Key）"
  );
  process.exit(1);
}

// ============ 通义千问客户端 ============
const qwen = new OpenAI({
  apiKey: DASHSCOPE_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

// ============ GitHub 请求头 ============
const headers = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "github-release-watcher",
};

// ============ 数据库初始化 ============
const db = new Database("releases.db");

// 创建表（如果不存在）
db.exec(`
  CREATE TABLE IF NOT EXISTS last_releases (
    repo TEXT PRIMARY KEY,
    last_published_at TEXT
  )
`);

// ============ 获取你 Starred 的项目列表（分页处理） ============
async function getStarredRepos() {
  let repos = [];
  let page = 1;
  const perPage = 100; // 每次最多100个

  try {
    while (true) {
      const res = await axios.get(`https://api.github.com/user/starred`, {
        headers,
        params: { per_page: perPage, page },
      });

      if (res.data.length === 0) break; // 没有更多了

      repos.push(...res.data.map((repo) => repo.full_name));
      page++;
    }

    console.log(`成功获取 ${repos.length} 个 Starred 项目`);
    return repos;
  } catch (err) {
    console.error(
      "❌ 获取 Starred 项目列表失败:",
      err.response?.data?.message || err.message
    );
    return [];
  }
}

// ============ 获取项目最新 release ============
async function getLatestRelease(repo) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers }
    );
    console.log(`✅ 获取 ${repo} 的最新 release 成功`);
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null; // 项目没有 release
    console.error(
      `❌ 获取 ${repo} 的 release 失败:`,
      err.response?.data?.message || err.message
    );
    return null;
  }
}

// ============ 使用通义千问总结 release ============
async function summarizeRelease(body) {
  if (!body || body.trim() === "") {
    return "（无详细变更日志）";
  }

  const prompt = `用简洁的中文总结以下 GitHub release 的主要变更，用 3-5 条 bullet points：\n\n${body.substring(
    0,
    8000
  )}`;

  try {
    const response = await qwen.chat.completions.create({
      model: "qwen-plus", // 可换成 qwen-max（更强）或 qwen-turbo（更快更便宜）
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
    });
    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ 千问总结失败:", err.message);
    return "（AI 总结失败）";
  }
}

// ============ 保存总结到 Markdown 文件 ============
async function saveSummary(updates) {
  if (updates.length === 0) {
    console.log("✅ 今天没有新 release，无需生成文件");
    return;
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `${today}-GitHub-更新总结.md`;
  const filepath = path.join(__dirname, filename);

  let content = `# ${today} GitHub Release 更新总结\n\n`;
  content += `共发现 **${updates.length}** 个项目发布新版本\n`;
  content += `生成时间：${new Date().toLocaleString("zh-CN")}\n\n`;
  content += `---\n\n`;

  updates.forEach((update) => {
    content += update;
  });

  content += `\n---\n*由通义千问自动总结生成*\n`;

  fs.writeFileSync(filepath, content, "utf-8");
  console.log(`🎉 总结文件已生成：${filename}（共 ${updates.length} 个更新）`);
}

// ============ 主检查函数 ============
async function checkUpdates() {
  console.log("\n🔍 开始检查 GitHub Starred 项目的新 release...");

  const updates = [];
  const repos = await getStarredRepos();

  if (repos.length === 0) {
    console.log("⚠️  你目前没有 Starred 任何项目，或者 token 权限不足");
    return;
  }

  console.log(`当前 Starred 项目列表：${repos.join(", ")}`);
  console.log(`正在检查 ${repos.length} 个 Starred 项目...`);

  for (const repo of repos) {
    const release = await getLatestRelease(repo);
    if (!release) continue;

    const { tag_name, published_at, body, html_url, name = "" } = release;

    // 检查是否新发布（better-sqlite3 同步方式）
    const stmt = db.prepare(
      "SELECT last_published_at FROM last_releases WHERE repo = ?"
    );
    const row = stmt.get(repo); // 同步返回一行，或 undefined

    if (!row || row.last_published_at < published_at) {
      console.log(`  ✨ 新 release：${repo} ${tag_name}`);
      const summary = await summarizeRelease(body);

      const updateText =
        `### [${repo}](https://github.com/${repo})\n` +
        `- **版本**：${tag_name}\n` +
        `- **发布名称**：${name || "无"}\n` +
        `- **发布时间**：${new Date(published_at).toLocaleString("zh-CN")}\n` +
        `- **链接**：[查看完整 Release](${html_url})\n\n` +
        `**变更总结**：\n${summary}\n\n---\n\n`;

      updates.push(updateText);

      // 更新数据库（同步）
      db.prepare(
        "INSERT OR REPLACE INTO last_releases (repo, last_published_at) VALUES (?, ?)"
      ).run(repo, published_at);
    }
  }

  await saveSummary(updates);
}

// ============ 定时任务：每天早上 8 点自动运行 ============
schedule.scheduleJob("0 8 * * *", () => {
  console.log("\n🕗 定时任务触发（每天 8:00）");
  checkUpdates();
});

// ============ 启动提示 ============
console.log("🚀 GitHub Release 监控已启动！");
console.log("   每天早上 8:00 会自动检查并生成总结文件");
console.log("   你现在可以手动运行一次测试：pnpm start\n");

// 如果你想启动时立即检查一次，取消下面这行注释
checkUpdates();
