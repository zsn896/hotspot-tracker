    if (req.method !== 'GET') {
      return res
        .status(405)
        .json({
          ok: false,
          error: 'Method not allowed'
        });
    }

    const group = await getManual();

    if (
      !group ||
      !group.active
    ) {
      return res
        .status(200)
        .json({
          ok: true,
          manual: null
        });
    }

    const sync = await backfillManual(group);

    return res
      .status(200)
      .json({
        ok: true,
        manual: await readManual(group),
        processed: sync.processed,
        latest: {
          id: sync.latest.id,
          date: sync.latest.date,
          time: sync.latest.time
        }
      });

  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,
        error:
          e.message ||
          String(e)
      });
  }
};
