/**
 * packs/linux/dispatch-chains.ts — pre-built dispatch chain templates
 * for Linux kernel registration APIs whose runtime dispatch path is
 * architecturally fixed.
 *
 * When the pattern-resolver's store/dispatch/trigger stages fail (because
 * clangd can't resolve through kernel macros/inlines), these templates
 * provide the known dispatch chain directly. The resolver fills in
 * %CALLBACK% with the actual callback name and %KEY% with the dispatch
 * key (e.g. IRQ number, timer name).
 *
 * Each template encodes the kernel's runtime dispatch architecture:
 *   hardware IRQ → do_IRQ → handle_irq_event → handler
 *   timer expiry → run_timer_softirq → call_timer_fn → handler
 *   workqueue    → process_one_work → handler
 *   tasklet      → tasklet_action → handler
 *   kthread      → kthread → handler
 *   VFS read     → ksys_read → vfs_read → f_op->read → handler
 *   VFS write    → ksys_write → vfs_write → f_op->write → handler
 *   chrdev       → register_chrdev → chrdev_open → f_op dispatch
 */

import type { DispatchChainTemplate } from "../types.js"

const linuxDispatchChains: readonly DispatchChainTemplate[] = [
  // ── Hardware interrupts ──────────────────────────────────────────────────
  {
    registrationApi: "request_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "Hardware interrupt IRQ %KEY%",
  },
  {
    registrationApi: "request_threaded_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "irq_thread_fn", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "Threaded IRQ handler for IRQ %KEY%",
  },
  {
    registrationApi: "devm_request_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "devm-managed IRQ handler for IRQ %KEY%",
  },
  {
    registrationApi: "devm_request_threaded_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "irq_thread_fn", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "devm-managed threaded IRQ handler for IRQ %KEY%",
  },

  // ── Timers ───────────────────────────────────────────────────────────────
  {
    registrationApi: "timer_setup",
    chain: ["timer_expiry", "run_timer_softirq", "call_timer_fn", "%CALLBACK%"],
    triggerKind: "timer_expiry",
    triggerDescription: "Kernel timer expiry callback",
  },

  // ── Workqueues ───────────────────────────────────────────────────────────
  {
    registrationApi: "INIT_WORK",
    chain: ["workqueue_thread", "process_one_work", "%CALLBACK%"],
    triggerKind: "workqueue",
    triggerDescription: "Workqueue deferred work callback",
  },
  {
    registrationApi: "INIT_DELAYED_WORK",
    chain: ["workqueue_thread", "process_one_work", "%CALLBACK%"],
    triggerKind: "workqueue",
    triggerDescription: "Delayed workqueue callback",
  },

  // ── Tasklets ─────────────────────────────────────────────────────────────
  {
    registrationApi: "tasklet_init",
    chain: ["softirq", "tasklet_action", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Tasklet softirq callback",
  },

  // ── Kernel threads ───────────────────────────────────────────────────────
  {
    registrationApi: "kthread_run",
    chain: ["kthread", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Kernel thread entry point",
  },
  {
    registrationApi: "kthread_create",
    chain: ["kthread", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Kernel thread entry point",
  },

  // ── VFS file operations ──────────────────────────────────────────────────
  // These are for the struct-field registration pattern, keyed by the
  // struct-field name (.read, .write, .open, etc.). The registrationApi
  // here is the container variable name which the resolver matches against
  // the generic struct-field classifier's viaRegistrationApi output.
  // We use a wildcard approach: any file_operations container triggers
  // the VFS dispatch template based on the field name.
  {
    registrationApi: "__struct_field:file_operations.read",
    chain: ["userspace_read_syscall", "ksys_read", "vfs_read", "f_op->read", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace read() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.write",
    chain: ["userspace_write_syscall", "ksys_write", "vfs_write", "f_op->write", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace write() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.open",
    chain: ["userspace_open_syscall", "do_sys_openat2", "do_filp_open", "f_op->open", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace open() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.release",
    chain: ["__fput", "f_op->release", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "File descriptor close → VFS release dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.llseek",
    chain: ["userspace_lseek_syscall", "ksys_lseek", "vfs_llseek", "f_op->llseek", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace lseek() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.mmap",
    chain: ["userspace_mmap_syscall", "do_mmap", "call_mmap", "f_op->mmap", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace mmap() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.unlocked_ioctl",
    chain: ["userspace_ioctl_syscall", "do_vfs_ioctl", "f_op->unlocked_ioctl", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace ioctl() syscall → VFS dispatch",
  },

  // ── Character device registration ────────────────────────────────────────
  {
    registrationApi: "register_chrdev",
    chain: ["userspace_open", "chrdev_open", "fops_dispatch", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Character device open for major %KEY%",
  },

  // ── Net device ops ───────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:net_device_ops.ndo_open",
    chain: ["dev_open", "ndo_open", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Network interface open → ndo_open dispatch",
  },
  {
    registrationApi: "__struct_field:net_device_ops.ndo_start_xmit",
    chain: ["dev_queue_xmit", "__dev_queue_xmit", "ndo_start_xmit", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Network packet transmit → ndo_start_xmit dispatch",
  },

  // ── proc/debugfs ─────────────────────────────────────────────────────────
  {
    registrationApi: "proc_create",
    chain: ["userspace_read_proc", "proc_reg_read", "f_op_dispatch", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace reads /proc/%KEY%",
  },
  {
    registrationApi: "proc_create_single",
    chain: ["userspace_read_proc", "proc_reg_read", "single_open", "seq_read", "show_fn", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace reads /proc/%KEY% (single-open)",
  },
  {
    registrationApi: "proc_create_single_data",
    chain: ["userspace_read_proc", "proc_reg_read", "single_open", "seq_read", "show_fn", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace reads /proc/%KEY% (single-open with data)",
  },
  {
    registrationApi: "debugfs_create_file",
    chain: ["userspace_read_debugfs", "debugfs_file_read", "f_op_dispatch", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace reads debugfs file %KEY%",
  },

  // ── Additional file_operations fields ──────────────────────────────────
  {
    registrationApi: "__struct_field:file_operations.poll",
    chain: ["userspace_poll_syscall", "do_sys_poll", "vfs_poll", "f_op->poll", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace poll()/select()/epoll() → VFS poll dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.fasync",
    chain: ["userspace_fcntl_syscall", "do_fcntl", "f_op->fasync", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace fcntl(F_SETFL, FASYNC) → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.read_iter",
    chain: ["userspace_read_syscall", "ksys_read", "vfs_read", "call_read_iter", "f_op->read_iter", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace read() → VFS read_iter dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.write_iter",
    chain: ["userspace_write_syscall", "ksys_write", "vfs_write", "call_write_iter", "f_op->write_iter", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace write() → VFS write_iter dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.splice_read",
    chain: ["userspace_splice_syscall", "do_splice", "f_op->splice_read", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace splice() → VFS splice_read dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.splice_write",
    chain: ["userspace_splice_syscall", "do_splice", "f_op->splice_write", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace splice() → VFS splice_write dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.compat_ioctl",
    chain: ["userspace_ioctl_syscall", "compat_sys_ioctl", "f_op->compat_ioctl", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace ioctl() (compat) → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.uring_cmd",
    chain: ["io_uring_submit", "io_uring_cmd", "f_op->uring_cmd", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "io_uring command → f_op->uring_cmd dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.get_unmapped_area",
    chain: ["mmap_region", "get_unmapped_area", "f_op->get_unmapped_area", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "mmap address selection → f_op->get_unmapped_area dispatch",
  },

  // ── PCI driver ──────────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:pci_driver.probe",
    chain: ["pci_bus_match", "pci_device_probe", "drv->probe", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "PCI device probe on bus enumeration",
  },
  {
    registrationApi: "__struct_field:pci_driver.remove",
    chain: ["pci_device_remove", "drv->remove", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "PCI device remove on driver unbind",
  },

  // ── Platform driver ─────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:platform_driver.probe",
    chain: ["platform_bus_match", "platform_probe", "drv->probe", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Platform device probe on bus enumeration",
  },
  {
    registrationApi: "__struct_field:platform_driver.remove",
    chain: ["platform_remove", "drv->remove", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Platform device remove on driver unbind",
  },

  // ── Notifier chains ─────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:notifier_block.notifier_call",
    chain: ["notifier_call_chain", "nb->notifier_call", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Kernel notifier chain callback",
  },

  // ── VM operations ───────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:vm_operations_struct.fault",
    chain: ["handle_pte_fault", "do_fault", "vma->vm_ops->fault", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Page fault → VM ops fault handler",
  },
  {
    registrationApi: "__struct_field:vm_operations_struct.open",
    chain: ["vma_open", "vma->vm_ops->open", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VMA open → VM ops open handler",
  },
  {
    registrationApi: "__struct_field:vm_operations_struct.close",
    chain: ["vma_close", "vma->vm_ops->close", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VMA close → VM ops close handler",
  },

  // ── AGP bridge driver ───────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:agp_bridge_driver.configure",
    chain: ["agp_backend_initialize", "bridge->driver->configure", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP bridge configure on initialization",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.cleanup",
    chain: ["agp_backend_cleanup", "bridge->driver->cleanup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP bridge cleanup on teardown",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.fetch_size",
    chain: ["agp_backend_initialize", "bridge->driver->fetch_size", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP bridge aperture size fetch",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.tlb_flush",
    chain: ["agp_generic_mask_memory", "bridge->driver->tlb_flush", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP TLB flush on memory mapping",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.mask_memory",
    chain: ["agp_generic_alloc_page", "bridge->driver->mask_memory", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP memory mask on allocation",
  },

  // ── Intel GTT driver ────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:intel_gtt_driver.setup",
    chain: ["intel_gtt_init", "driver->setup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT setup on initialization",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.cleanup",
    chain: ["intel_gtt_cleanup", "driver->cleanup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT cleanup on teardown",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.write_entry",
    chain: ["intel_gtt_insert_sg_entries", "driver->write_entry", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT page table write entry",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.check_flags",
    chain: ["intel_gtt_insert_sg_entries", "driver->check_flags", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT flags validation",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.chipset_flush",
    chain: ["intel_gtt_chipset_flush", "driver->chipset_flush", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT chipset flush",
  },

  // ── RCU callbacks ───────────────────────────────────────────────────────
  {
    registrationApi: "call_rcu",
    chain: ["rcu_grace_period", "rcu_do_batch", "rcu_cblist_invoke", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "RCU grace period expiry → callback invocation",
  },
  {
    registrationApi: "call_rcu_hurry",
    chain: ["rcu_grace_period", "rcu_do_batch", "rcu_cblist_invoke", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Expedited RCU callback invocation",
  },
  {
    registrationApi: "call_srcu",
    chain: ["srcu_grace_period", "srcu_invoke_callbacks", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "SRCU callback invocation after grace period",
  },

  // ── IPI cross-CPU calls ─────────────────────────────────────────────────
  {
    registrationApi: "smp_call_function",
    chain: ["IPI_interrupt", "generic_smp_call_function", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "IPI cross-CPU function call on all other CPUs",
  },
  {
    registrationApi: "smp_call_function_single",
    chain: ["IPI_interrupt", "generic_smp_call_function_single", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "IPI cross-CPU function call on specific CPU",
  },
  {
    registrationApi: "smp_call_function_many",
    chain: ["IPI_interrupt", "generic_smp_call_function_many", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "IPI cross-CPU function call on CPU mask",
  },

  // ── Softirq ─────────────────────────────────────────────────────────────
  {
    registrationApi: "open_softirq",
    chain: ["hardware_irq", "do_softirq", "softirq_action", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "Softirq handler for softirq %KEY%",
  },

  // ── CPU hotplug ─────────────────────────────────────────────────────────
  {
    registrationApi: "cpuhp_setup_state",
    chain: ["cpu_hotplug_event", "cpuhp_invoke_callback", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "CPU hotplug state transition callback",
  },
  {
    registrationApi: "cpuhp_setup_state_nocalls",
    chain: ["cpu_hotplug_event", "cpuhp_invoke_callback", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "CPU hotplug state transition (no initial call)",
  },

  // ── Stop machine ────────────────────────────────────────────────────────
  {
    registrationApi: "stop_machine",
    chain: ["stop_machine_cpuslocked", "multi_cpu_stop", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Stop-machine all-CPU synchronized callback",
  },

  // ── NAPI poll ───────────────────────────────────────────────────────────
  {
    registrationApi: "netif_napi_add",
    chain: ["net_rx_action", "napi_poll", "napi->poll", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "NAPI poll in network receive softirq",
  },
  {
    registrationApi: "netif_napi_add_weight",
    chain: ["net_rx_action", "napi_poll", "napi->poll", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "NAPI poll (weighted) in network receive softirq",
  },

  // ── Module lifecycle ────────────────────────────────────────────────────
  {
    registrationApi: "module_init",
    chain: ["kernel_boot", "do_initcalls", "do_one_initcall", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Module init during kernel boot or module load",
  },
  {
    registrationApi: "module_exit",
    chain: ["module_unload", "SyS_delete_module", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Module exit during module unload",
  },
  {
    registrationApi: "late_initcall",
    chain: ["kernel_boot", "do_initcalls", "do_one_initcall", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Late initcall during kernel boot",
  },
  {
    registrationApi: "subsys_initcall",
    chain: ["kernel_boot", "do_initcalls", "do_one_initcall", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Subsystem initcall during kernel boot",
  },
  {
    registrationApi: "core_initcall",
    chain: ["kernel_boot", "do_initcalls", "do_one_initcall", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Core initcall during kernel boot",
  },
  {
    registrationApi: "device_initcall",
    chain: ["kernel_boot", "do_initcalls", "do_one_initcall", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Device initcall during kernel boot",
  },
  {
    registrationApi: "fs_initcall",
    chain: ["kernel_boot", "do_initcalls", "do_one_initcall", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Filesystem initcall during kernel boot",
  },
  {
    registrationApi: "arch_initcall",
    chain: ["kernel_boot", "do_initcalls", "do_one_initcall", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Architecture initcall during kernel boot",
  },

  // ── Filesystem struct-field callbacks ──────────────────────────────────
  {
    registrationApi: "__struct_field:address_space_operations.readpage",
    chain: ["page_cache_sync_readahead", "read_pages", "aops->readpage", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Page cache readahead → address_space_operations.readpage",
  },
  {
    registrationApi: "__struct_field:address_space_operations.writepage",
    chain: ["writeback_thread", "do_writepages", "aops->writepage", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Writeback → address_space_operations.writepage",
  },
  {
    registrationApi: "__struct_field:address_space_operations.readahead",
    chain: ["page_cache_sync_readahead", "read_pages", "aops->readahead", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Page cache readahead → address_space_operations.readahead",
  },
  {
    registrationApi: "__struct_field:inode_operations.lookup",
    chain: ["path_lookupat", "lookup_slow", "iop->lookup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VFS path lookup → inode_operations.lookup",
  },
  {
    registrationApi: "__struct_field:inode_operations.create",
    chain: ["vfs_create", "dir->i_op->create", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VFS create → inode_operations.create",
  },
  {
    registrationApi: "__struct_field:inode_operations.mkdir",
    chain: ["vfs_mkdir", "dir->i_op->mkdir", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VFS mkdir → inode_operations.mkdir",
  },
  {
    registrationApi: "__struct_field:inode_operations.unlink",
    chain: ["vfs_unlink", "dir->i_op->unlink", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VFS unlink → inode_operations.unlink",
  },
  {
    registrationApi: "__struct_field:super_operations.alloc_inode",
    chain: ["new_inode", "alloc_inode", "sb->s_op->alloc_inode", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VFS alloc_inode → super_operations.alloc_inode",
  },
  {
    registrationApi: "__struct_field:super_operations.destroy_inode",
    chain: ["iput", "destroy_inode", "sb->s_op->destroy_inode", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VFS destroy_inode → super_operations.destroy_inode",
  },

  // ── Block device operations ─────────────────────────────────────────────
  {
    registrationApi: "__struct_field:block_device_operations.open",
    chain: ["blkdev_open", "bdev->bd_disk->fops->open", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Block device open → block_device_operations.open",
  },
  {
    registrationApi: "__struct_field:block_device_operations.submit_bio",
    chain: ["submit_bio", "blk_mq_submit_bio", "disk->fops->submit_bio", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Block I/O submission → block_device_operations.submit_bio",
  },
  {
    registrationApi: "__struct_field:block_device_operations.ioctl",
    chain: ["blkdev_ioctl", "disk->fops->ioctl", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Block device ioctl → block_device_operations.ioctl",
  },

  // ── Power management struct-field callbacks ─────────────────────────────
  {
    registrationApi: "__struct_field:dev_pm_ops.suspend",
    chain: ["pm_suspend", "dpm_suspend", "dev->pm->suspend", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "System suspend → dev_pm_ops.suspend",
  },
  {
    registrationApi: "__struct_field:dev_pm_ops.resume",
    chain: ["pm_resume", "dpm_resume", "dev->pm->resume", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "System resume → dev_pm_ops.resume",
  },
  {
    registrationApi: "__struct_field:dev_pm_ops.runtime_suspend",
    chain: ["rpm_suspend", "dev->pm->runtime_suspend", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Runtime PM suspend → dev_pm_ops.runtime_suspend",
  },
  {
    registrationApi: "__struct_field:dev_pm_ops.runtime_resume",
    chain: ["rpm_resume", "dev->pm->runtime_resume", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Runtime PM resume → dev_pm_ops.runtime_resume",
  },

  // ── USB driver ──────────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:usb_driver.probe",
    chain: ["usb_probe_interface", "driver->probe", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "USB device probe → usb_driver.probe",
  },
  {
    registrationApi: "__struct_field:usb_driver.disconnect",
    chain: ["usb_unbind_interface", "driver->disconnect", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "USB device disconnect → usb_driver.disconnect",
  },

  // ── I2C driver ──────────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:i2c_driver.probe",
    chain: ["i2c_device_probe", "driver->probe", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "I2C device probe → i2c_driver.probe",
  },

  // ── SPI driver ──────────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:spi_driver.probe",
    chain: ["spi_drv_probe", "sdrv->probe", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "SPI device probe → spi_driver.probe",
  },

  // ── Input subsystem ─────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:input_handler.event",
    chain: ["input_event", "input_pass_values", "handler->event", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Input event → input_handler.event",
  },
  {
    registrationApi: "__struct_field:input_handler.connect",
    chain: ["input_register_device", "input_attach_handler", "handler->connect", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Input device connect → input_handler.connect",
  },

  // ── UART/serial ─────────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:uart_ops.startup",
    chain: ["uart_port_startup", "uport->ops->startup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "UART port startup → uart_ops.startup",
  },
  {
    registrationApi: "__struct_field:uart_ops.shutdown",
    chain: ["uart_port_shutdown", "uport->ops->shutdown", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "UART port shutdown → uart_ops.shutdown",
  },

  // ── Socket operations ───────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:proto_ops.connect",
    chain: ["sys_connect", "__sys_connect", "sock->ops->connect", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace connect() syscall → proto_ops.connect",
  },
  {
    registrationApi: "__struct_field:proto_ops.accept",
    chain: ["sys_accept4", "__sys_accept4", "sock->ops->accept", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace accept() syscall → proto_ops.accept",
  },
  {
    registrationApi: "__struct_field:proto_ops.sendmsg",
    chain: ["sys_sendmsg", "sock_sendmsg", "sock->ops->sendmsg", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace sendmsg() syscall → proto_ops.sendmsg",
  },
  {
    registrationApi: "__struct_field:proto_ops.recvmsg",
    chain: ["sys_recvmsg", "sock_recvmsg", "sock->ops->recvmsg", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace recvmsg() syscall → proto_ops.recvmsg",
  },
]

export default linuxDispatchChains
